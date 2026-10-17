(function (root) {
  'use strict';

  var REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
  var ACTOR_ID = /^[A-Za-z0-9_-]{1,64}$/;
  var KINDS = ['reference', 'read'];

  function fail(message) { throw new Error(message); }
  function isFiniteNumber(value) { return typeof value === 'number' && Number.isFinite(value); }
  function time(value) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }

  function copy(value) {
    if (Array.isArray(value)) return value.map(copy);
    if (value && typeof value === 'object') {
      return Object.keys(value).reduce(function (out, key) { out[key] = copy(value[key]); return out; }, {});
    }
    return value;
  }

  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') {
      return '{' + Object.keys(value).sort().map(function (key) {
        return JSON.stringify(key) + ':' + canonical(value[key]);
      }).join(',') + '}';
    }
    return JSON.stringify(value);
  }

  function validMaterial(material) {
    return material && typeof material === 'object' && !Array.isArray(material) &&
      REQUEST_ID.test(String(material.id || '')) && typeof material.label === 'string' &&
      material.label.length > 0 && material.label.length <= 200 && KINDS.indexOf(material.permission) >= 0;
  }

  function validateTerms(terms) {
    if (!terms || typeof terms !== 'object' || Array.isArray(terms)) fail('terms shape');
    if (typeof terms.purpose !== 'string' || !terms.purpose.trim() || terms.purpose.length > 500) fail('terms purpose');
    if (!terms.dateRange || !time(terms.dateRange.start) || !time(terms.dateRange.end) ||
      Date.parse(terms.dateRange.end) < Date.parse(terms.dateRange.start)) fail('terms date range');
    if (typeof terms.timezone !== 'string' || !terms.timezone.trim() || terms.timezone.length > 64) fail('terms timezone');
    if (!terms.effortRange || typeof terms.effortRange !== 'object') fail('terms effort range');
    var min = terms.effortRange.min, max = terms.effortRange.max;
    if (min != null && (!isFiniteNumber(min) || min < 0 || min > 10080)) fail('terms effort minimum');
    if (max != null && (!isFiniteNumber(max) || max < 0 || max > 10080)) fail('terms effort maximum');
    if (min != null && max != null && max < min) fail('terms effort order');
    if (terms.deadline != null && !time(terms.deadline)) fail('terms deadline');
    if (!Array.isArray(terms.materials) || !terms.materials.every(validMaterial)) fail('terms materials');
    return {
      purpose: terms.purpose.trim(),
      dateRange: { start: terms.dateRange.start, end: terms.dateRange.end },
      timezone: terms.timezone.trim(),
      effortRange: { min: min == null ? null : min, max: max == null ? null : max },
      deadline: terms.deadline == null ? null : terms.deadline,
      materials: terms.materials.map(function (m) { return { id: m.id, label: m.label, permission: m.permission }; })
    };
  }

  function hashAgreementTerms(terms) {
    var normalized = validateTerms(copy(terms));
    normalized.materials.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    var hash = 2166136261;
    for (var i = 0; i < canonical(normalized).length; i++) {
      hash ^= canonical(normalized).charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function response(actorId) {
    return { actorId: actorId, status: 'pending', termsVersion: null, termsHash: null, respondedAt: null, reasonCode: null };
  }

  function createAgreementRequest(input) {
    if (!input || typeof input !== 'object') fail('input shape');
    if (!REQUEST_ID.test(String(input.id || ''))) fail('request id');
    if (!ACTOR_ID.test(String(input.proposerId || '')) || !ACTOR_ID.test(String(input.recipientId || '')) ||
      input.proposerId === input.recipientId) fail('request parties');
    if (!time(input.now) || !time(input.expiresAt) || Date.parse(input.expiresAt) <= Date.parse(input.now)) fail('request expiry');
    var terms = validateTerms(input.terms);
    return {
      id: input.id, proposerId: input.proposerId, recipientId: input.recipientId, status: 'sent',
      currentVersion: 1,
      versions: [{ version: 1, terms: terms, termsHash: hashAgreementTerms(terms), createdBy: input.proposerId, createdAt: input.now }],
      responses: { [input.proposerId]: response(input.proposerId), [input.recipientId]: response(input.recipientId) },
      expiresAt: input.expiresAt, createdAt: input.now, updatedAt: input.now, revision: 1, agreement: null
    };
  }

  function partiesOf(request) { return [request.proposerId, request.recipientId]; }
  function assertParty(request, actorId) { if (partiesOf(request).indexOf(actorId) < 0) fail('actor is not a party to this request'); }
  function isExpired(request, now) { return Date.parse(now) >= Date.parse(request.expiresAt); }
  function withStatus(request, status, now) { return Object.assign(copy(request), { status: status, updatedAt: now, revision: request.revision + 1 }); }
  function terminal(request) { return ['withdrawn', 'expired', 'rejected', 'agreed'].indexOf(request.status) >= 0; }
  function currentVersion(request) {
    return request.versions.filter(function (v) { return v.version === request.currentVersion; })[0] || fail('current version is missing');
  }

  function counterProposeAgreement(request, input) {
    assertParty(request, input.actorId);
    if (terminal(request)) fail('request is terminal');
    if (isExpired(request, input.now)) return withStatus(request, 'expired', input.now);
    if (!time(input.now)) fail('time');
    var terms = validateTerms(input.terms), version = request.currentVersion + 1;
    var next = copy(request);
    next.status = 'received';
    next.currentVersion = version;
    next.versions.push({ version: version, terms: terms, termsHash: hashAgreementTerms(terms), createdBy: input.actorId, createdAt: input.now });
    next.responses = partiesOf(request).reduce(function (out, actorId) { out[actorId] = response(actorId); return out; }, {});
    next.updatedAt = input.now;
    next.revision++;
    next.agreement = null;
    return next;
  }

  function respondToAgreementRequest(request, input) {
    assertParty(request, input.actorId);
    if (terminal(request)) fail('request is terminal');
    if (input.response !== 'accepted' && input.response !== 'rejected') fail('response');
    if (!time(input.now)) fail('time');
    if (isExpired(request, input.now)) return withStatus(request, 'expired', input.now);
    var version = currentVersion(request);
    if (input.termsVersion !== version.version || input.termsHash !== version.termsHash) fail('terms version or hash is stale');
    var next = copy(request);
    next.responses[input.actorId] = {
      actorId: input.actorId, status: input.response, termsVersion: input.termsVersion,
      termsHash: input.termsHash, respondedAt: input.now, reasonCode: input.reasonCode == null ? null : String(input.reasonCode).slice(0, 64)
    };
    next.updatedAt = input.now;
    next.revision++;
    if (input.response === 'rejected') { next.status = 'rejected'; return next; }
    var agreed = partiesOf(request).every(function (actorId) {
      var item = next.responses[actorId];
      return item.status === 'accepted' && item.termsVersion === input.termsVersion && item.termsHash === input.termsHash;
    });
    if (!agreed) { next.status = 'received'; return next; }
    next.status = 'agreed';
    next.agreement = {
      requestId: request.id, termsVersion: version.version, termsHash: version.termsHash,
      parties: partiesOf(request), formedAt: input.now, expiresAt: request.expiresAt, executionRefs: []
    };
    return next;
  }

  function withdrawAgreementRequest(request, input) {
    assertParty(request, input.actorId);
    if (request.status === 'agreed') fail('an agreed request requires cancellation, not withdrawal');
    if (request.status === 'withdrawn') return request;
    return withStatus(request, 'withdrawn', input.now);
  }

  function refreshAgreementExpiry(request, now) {
    if (!time(now)) fail('time');
    if (['agreed', 'withdrawn', 'rejected', 'expired'].indexOf(request.status) >= 0) return request;
    return isExpired(request, now) ? withStatus(request, 'expired', now) : request;
  }

  // The local demo has no server authority. Reject corrupt snapshots before UI projection.
  function validateStoredRequest(request, allowedActors) {
    try {
      if (!request || typeof request !== 'object' || Array.isArray(request) || !REQUEST_ID.test(request.id) ||
        !Number.isInteger(request.revision) || request.revision < 1 || !time(request.createdAt) || !time(request.updatedAt) || !time(request.expiresAt) ||
        ['sent', 'received', 'agreed', 'withdrawn', 'rejected', 'expired'].indexOf(request.status) < 0) return false;
      var parties = partiesOf(request);
      if (parties[0] === parties[1] || !parties.every(function (actor) {
        return typeof actor === 'string' && ACTOR_ID.test(actor) && ['__proto__', 'constructor', 'prototype'].indexOf(actor) < 0 && (!allowedActors || allowedActors.indexOf(actor) >= 0);
      })) return false;
      if (!Array.isArray(request.versions) || !request.versions.length || !Number.isInteger(request.currentVersion) || request.currentVersion !== request.versions.length) return false;
      if (!request.versions.every(function (version, index) {
        return version && version.version === index + 1 && parties.indexOf(version.createdBy) >= 0 && time(version.createdAt) && version.termsHash === hashAgreementTerms(version.terms);
      })) return false;
      var current = currentVersion(request);
      if (!request.responses || typeof request.responses !== 'object' || Array.isArray(request.responses)) return false;
      if (!parties.every(function (actor) {
        var item = Object.prototype.hasOwnProperty.call(request.responses, actor) && request.responses[actor];
        if (!item || item.actorId !== actor || ['pending', 'accepted', 'rejected'].indexOf(item.status) < 0) return false;
        return item.status === 'pending' ? item.termsVersion == null && item.termsHash == null :
          item.termsVersion === current.version && item.termsHash === current.termsHash && time(item.respondedAt);
      })) return false;
      if (request.status !== 'agreed') return request.agreement == null;
      var agreement = request.agreement;
      return !!agreement && parties.every(function (actor) { return request.responses[actor].status === 'accepted'; }) &&
        agreement.requestId === request.id && agreement.termsVersion === current.version && agreement.termsHash === current.termsHash &&
        Array.isArray(agreement.parties) && agreement.parties.length === 2 && parties.every(function (actor) { return agreement.parties.indexOf(actor) >= 0; }) &&
        time(agreement.formedAt) && agreement.expiresAt === request.expiresAt && Array.isArray(agreement.executionRefs) && agreement.executionRefs.length === 0;
    } catch { return false; }
  }

  root.TangoAgreements = {
    validateStoredRequest: validateStoredRequest,
    hashAgreementTerms: hashAgreementTerms,
    createAgreementRequest: createAgreementRequest,
    counterProposeAgreement: counterProposeAgreement,
    respondToAgreementRequest: respondToAgreementRequest,
    withdrawAgreementRequest: withdrawAgreementRequest,
    refreshAgreementExpiry: refreshAgreementExpiry
  };
}(typeof window !== 'undefined' ? window : globalThis));
