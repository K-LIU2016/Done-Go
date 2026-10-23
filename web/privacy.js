(function (root) {
  'use strict';
  var DEFAULTS = { mode: 'auto', path: '', url: '', model: '', consent: false };
  var KINDS = { necessary: 1, restore: 1, create: 1, connect: 1, explore: 1, stillness: 1 };
  var ID = /^[A-Za-z0-9_-]{1,64}$/;
  var HM = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
  var DATE = /^\d{4}-\d{2}-\d{2}$/;
  var MODEL_IDS = ['claude-sonnet-5.5', 'gpt-5.4', 'gemini-3.1-pro-preview'];
  var METHOD_CATEGORIES = ['read', 'write', 'code', 'meet', 'mail', 'screen', 'admin', 'grade', 'study', 'food', 'travel', 'exercise', 'connect', 'none', 'other'];
  var METHOD_USE_STATUS = ['applied', 'aborted', 'completed', 'dismissed'];
  function copy(o) { var out = {}; Object.keys(o || {}).forEach(function (k) { out[k] = o[k]; }); return out; }
  function object(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function pick(o, keys) { var out = {}; keys.forEach(function (key) { if (Object.prototype.hasOwnProperty.call(o, key)) out[key] = o[key]; }); return out; }
  function integer(n, low, high) { return Number.isInteger(n) && n >= low && n <= high; }
  function optionalText(o, key, max) { return o[key] == null || typeof o[key] === 'string' && o[key].length <= max; }
  function requiredText(o, key, max) { return typeof o[key] === 'string' && o[key].length > 0 && o[key].length <= max; }
  function isoTime(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
    var date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  }
  function validMethod(method) {
    if (!object(method) || typeof method.id !== 'string' || !ID.test(method.id) || !integer(method.version, 1, 1000)) return false;
    if (!requiredText(method, 'name', 60) || !optionalEnum(method, 'category', METHOD_CATEGORIES) || !optionalEnum(method, 'status', ['active', 'archived'])) return false;
    if (!optionalText(method, 'purpose', 400) || !optionalText(method, 'fit', 400) || !optionalText(method, 'unfit', 400)) return false;
    if (!optionalText(method, 'inputs', 800) || !optionalText(method, 'steps', 1500) || !optionalText(method, 'verify', 800)) return false;
    if (!optionalText(method, 'stop', 400) || !optionalText(method, 'modelReason', 400)) return false;
    if (!optionalEnum(method, 'modelId', MODEL_IDS.concat(['unknown']))) return false;
    if (!isoTime(method.createdAt) || !isoTime(method.updatedAt)) return false;
    if (method.origin != null) {
      var origin = method.origin;
      if (!object(origin) || typeof origin.taskId !== 'string' || !ID.test(origin.taskId)) return false;
      if (origin.date != null && origin.date !== '' && !realDate(origin.date)) return false;
      if (origin.quality != null && ['accepted', 'pending', 'rework'].indexOf(origin.quality) < 0) return false;
    }
    return true;
  }
  function validMethodUse(use) {
    if (!object(use) || typeof use.id !== 'string' || !ID.test(use.id) || typeof use.methodId !== 'string' || !ID.test(use.methodId)) return false;
    if (!integer(use.methodVersion, 1, 1000) || !requiredText(use, 'methodName', 60)) return false;
    if (typeof use.taskId !== 'string' || !ID.test(use.taskId) || !realDate(use.date)) return false;
    if (METHOD_USE_STATUS.indexOf(use.status) < 0 || !isoTime(use.at)) return false;
    return true;
  }
  function validMethodRef(value) {
    return object(value) && typeof value.methodId === 'string' && ID.test(value.methodId) && integer(value.version, 1, 1000) && requiredText(value, 'name', 60);
  }
  function validSourceRef(value) {
    if (!object(value) || value.kind !== 'discovery') return false;
    if (!requiredText(value, 'title', 200) || !optionalText(value, 'source', 80)) return false;
    if (typeof value.url !== 'string' || value.url.length > 500 || !/^https:\/\/\S+$/.test(value.url)) return false;
    try { var sourceURL = new URL(value.url); if (sourceURL.protocol !== 'https:' || sourceURL.username || sourceURL.password) return false; } catch { return false; }
    if (value.publishedAt != null && !realDate(value.publishedAt) && !isoTime(value.publishedAt)) return false;
    if (value.retrievedAt != null && !isoTime(value.retrievedAt)) return false;
    return true;
  }
  function validCollaborationRef(value) {
    return object(value) && ['groupId','stepId','linkId','accountId'].every(function(key){return typeof value[key] === 'string' && ID.test(value[key]);}) && requiredText(value, 'groupName', 120) && integer(value.stepRevision, 1, 1000000) && (value.acceptedStep == null || object(value.acceptedStep) && optionalText(value.acceptedStep,'name',160) && optionalText(value.acceptedStep,'startsAt',40) && optionalText(value.acceptedStep,'dueAt',40) && (value.acceptedStep.ownerId == null || typeof value.acceptedStep.ownerId==='string' && ID.test(value.acceptedStep.ownerId)));
  }
  function optionalBoolean(o, key) { return o[key] == null || typeof o[key] === 'boolean'; }
  function optionalEnum(o, key, values) { return o[key] == null || values.indexOf(o[key]) >= 0; }
  function validLearning(value) {
    if (value == null) return true;
    return object(value) && optionalEnum(value, 'ownAttempt', ['yes', 'no', 'unknown']) &&
      optionalEnum(value, 'hintLevel', ['unknown', 'hints', 'outline', 'answer', 'none']) &&
      optionalEnum(value, 'independentRetest', ['not-tested', 'passed', 'needs-practice']) &&
      optionalEnum(value, 'measurement', ['self-report']) && (value.skills == null || Array.isArray(value.skills) && value.skills.length <= 5 && value.skills.every(function (key) { return ['decomposition', 'context', 'constraints', 'verification', 'privacy'].indexOf(key) >= 0; }));
  }
  function validCosts(value, actual) {
    if (value == null) return true;
    if (!object(value) || !['preparation', 'checking', 'rework'].every(function (key) { return integer(value[key], 0, 1440); })) return false;
    var overhead = value.preparation + value.checking + value.rework;
    return overhead <= actual && (value.execution == null || integer(value.execution, 0, 1440) && overhead + value.execution === actual);
  }
  function validModelEvidence(value) {
    return (value.recording == null || integer(value.recording, 0, 1440)) && optionalEnum(value, 'modelId', MODEL_IDS.concat(['unknown'])) &&
      (value.modelVersion == null || typeof value.modelVersion === 'string' && (value.modelVersion === '' || /^[a-z0-9._-]{1,60}$/i.test(value.modelVersion))) &&
      optionalText(value, 'modelName', 80) && optionalEnum(value, 'inputScale', ['short', 'medium', 'long', 'unknown']) && optionalEnum(value, 'helpful', ['helpful', 'not-helpful', 'unclear']) && optionalBoolean(value, 'anonymousEvaluationConsent') && optionalEnum(value, 'dataMode', ['real', 'demo', 'unknown']);
  }
  function validAvailability(value) {
    if (value == null) return true;
    if (!object(value)) return false;
    return MODEL_IDS.every(function (key) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return true;
      var check = value[key];
      if (!object(check) || !optionalEnum(check, 'state', ['available', 'unavailable', 'unknown']) || !optionalEnum(check, 'reason', ['none', 'region', 'plan', 'quota', 'input', 'network', 'other'])) return false;
      if (check.checkedAt == null || check.checkedAt === '') return true;
      if (typeof check.checkedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(check.checkedAt)) return false;
      var date = new Date(check.checkedAt);
      return Number.isFinite(date.getTime()) && date.toISOString() === check.checkedAt;
    });
  }
  function cleanMeasurement(value) {
    var out = pick(value, ['usedAI', 'quality', 'recording', 'modelId', 'modelName', 'modelVersion', 'inputScale', 'helpful', 'anonymousEvaluationConsent', 'dataMode']);
    if (value.costs != null) out.costs = pick(value.costs, ['execution', 'preparation', 'checking', 'rework']);
    if (value.learning != null) {
      out.learning = pick(value.learning, ['ownAttempt', 'hintLevel', 'independentRetest', 'measurement']);
      if (value.learning.skills != null) out.learning.skills = value.learning.skills.slice();
    } else if (value.learning === null) out.learning = null;
    return out;
  }
  function cleanMethod(method) {
    var out = pick(method, ['id', 'version', 'createdAt', 'updatedAt', 'name', 'purpose', 'category', 'fit', 'unfit', 'inputs', 'steps', 'verify', 'stop', 'modelId', 'modelReason', 'status']);
    if (method.origin != null) out.origin = pick(method.origin, ['taskId', 'date', 'quality']);
    return out;
  }
  function cleanMethodUse(use) { return pick(use, ['id', 'methodId', 'methodVersion', 'methodName', 'taskId', 'date', 'status', 'at']); }
  function cleanEntry(value) {
    var out = pick(value, ['id', 'date', 'title', 'kind', 'start', 'end', 'done', 'prio', 'at', 'state', 'kept', 'use', 'note', 'intent', 'from', 'modelPreference']);
    if (value.collaborationRef != null) { out.collaborationRef = pick(value.collaborationRef, ['groupId','stepId','linkId','accountId','groupName','stepRevision']); if(value.collaborationRef.acceptedStep) out.collaborationRef.acceptedStep=pick(value.collaborationRef.acceptedStep,['name','startsAt','dueAt','ownerId']); }
    if (value.methodRef != null) out.methodRef = pick(value.methodRef, ['methodId', 'version', 'name']);
    if (value.sourceRef != null) out.sourceRef = pick(value.sourceRef, ['kind', 'title', 'source', 'url', 'publishedAt', 'retrievedAt']);
    if (value.completion != null) {
      out.completion = pick(value.completion, ['actual', 'before', 'plannedEnd', 'timeRecorded']);
      var measurement = cleanMeasurement(value.completion);
      Object.keys(measurement).forEach(function (key) { out.completion[key] = measurement[key]; });
    }
    if (value.freed != null) out.freed = pick(value.freed, ['pending', 'minutes', 'start', 'end']);
    if (value.forecast != null) out.forecast = pick(value.forecast, ['before', 'low', 'high', 'samples', 'source', 'dataMode']);
    if (value.ai != null) out.ai = pick(value.ai, ['used']);
    return out;
  }
  function preferences(raw) {
    raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    var hadSecret = typeof raw.key === 'string' && raw.key.length > 0;
    var out = copy(DEFAULTS);
    ['mode', 'path', 'url', 'model'].forEach(function (k) { if (typeof raw[k] === 'string') out[k] = raw[k].slice(0, 500); });
    out.key = '';
    out.consent = hadSecret ? false : raw.consent === true;
    return out;
  }
  function storablePreferences(raw) {
    raw = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    return {
      mode: typeof raw.mode === 'string' ? raw.mode.slice(0, 500) : DEFAULTS.mode,
      path: typeof raw.path === 'string' ? raw.path.slice(0, 500) : '',
      url: typeof raw.url === 'string' ? raw.url.slice(0, 500) : '',
      model: typeof raw.model === 'string' ? raw.model.slice(0, 500) : '',
      consent: raw.consent === true
    };
  }
  function safeEndpoint(value) {
    if (typeof value !== 'string' || !value || /\s/.test(value) || value.split('').some(function (character) { return character.charCodeAt(0) < 32; })) return false;
    var u;
    try { u = new URL(value); } catch { return false; }
    if (u.username || u.password || (u.protocol !== 'https:' && u.protocol !== 'http:')) return false;
    if (u.protocol === 'https:') return true;
    var h = String(u.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  }
  function realDate(s) {
    if (typeof s !== 'string' || !DATE.test(s)) return false;
    var p = s.split('-').map(Number), d = new Date(p[0], p[1] - 1, p[2]);
    return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2];
  }
  function time(s, allowEmpty) { return (allowEmpty && s === '') || (typeof s === 'string' && HM.test(s)); }
  function minutes(s) { var p = s.split(':').map(Number); return p[0] * 60 + p[1]; }
  function validEntry(e, allowEmpty) {
    if (!e || typeof e !== 'object' || Array.isArray(e) || typeof e.id !== 'string' || !ID.test(e.id) || !realDate(e.date) || typeof e.title !== 'string' || e.title.length > 200) return false;
    if (typeof e.kind !== 'string' || !Object.prototype.hasOwnProperty.call(KINDS, e.kind)) return false;
    if (Object.prototype.hasOwnProperty.call(e, 'modelPreference') && MODEL_IDS.indexOf(e.modelPreference) < 0) return false;
    if (!time(e.start, allowEmpty) || !time(e.end, allowEmpty)) return false;
    if (e.start !== '' && e.end !== '' && (minutes(e.end) < minutes(e.start) || minutes(e.end) === minutes(e.start) && !(e.done === true && object(e.completion) && e.completion.actual === 0 && time(e.completion.plannedEnd, false) && minutes(e.completion.plannedEnd) > minutes(e.start)))) return false;
    if (!optionalBoolean(e, 'done') || !optionalBoolean(e, 'at') || e.prio != null && !integer(e.prio, 1, 5)) return false;
    if (!optionalEnum(e, 'state', ['reserved', 'kept', 'partial', 'taken']) || !optionalEnum(e, 'use', ['necessary', 'restore', 'create', 'connect', 'explore', 'stillness'])) return false;
    if (e.kept != null && !integer(e.kept, 0, 1440) || !optionalText(e, 'note', 2000) || !optionalText(e, 'intent', 2000) || e.from != null && (typeof e.from !== 'string' || !ID.test(e.from))) return false;
    if (e.ai != null && (!object(e.ai) || !optionalBoolean(e.ai, 'used'))) return false;
    if (e.methodRef != null && !validMethodRef(e.methodRef)) return false;
    if (e.sourceRef != null && !validSourceRef(e.sourceRef)) return false;
    if (e.collaborationRef != null && !validCollaborationRef(e.collaborationRef)) return false;
    if (e.freed != null && (!object(e.freed) || !optionalBoolean(e.freed, 'pending') || !integer(e.freed.minutes, 0, 1440) || !time(e.freed.start, false) || !time(e.freed.end, false) || minutes(e.freed.end) <= minutes(e.freed.start))) return false;
    if (e.forecast != null) {
      var f = e.forecast;
      if (!object(f) || !integer(f.before, 0, 1440) || !optionalEnum(f, 'source', ['history', 'insufficient']) || f.samples != null && !integer(f.samples, 0, 1000000)) return false;
      if (f.low != null && !integer(f.low, -2073600, 1440) || f.high != null && !integer(f.high, -2073600, 1440)) return false;
    }
    if (e.completion != null) {
      var c = e.completion;
      if (!c || typeof c !== 'object' || Array.isArray(c)) return false;
      if (c.actual === null ? c.timeRecorded !== false || c.costs != null : !integer(c.actual, 0, 1440) || c.timeRecorded === false) return false;
      if (!optionalBoolean(c, 'timeRecorded')) return false;
      if (c.quality != null && ['accepted', 'pending', 'rework'].indexOf(c.quality) < 0) return false;
      if (c.plannedEnd != null && !time(c.plannedEnd, false)) return false;
      if (c.before != null && (!Number.isInteger(c.before) || c.before < 0 || c.before > 1440)) return false;
      if (!optionalBoolean(c, 'usedAI') || !validCosts(c.costs, c.actual) || !validLearning(c.learning) || !validModelEvidence(c)) return false;
    }
    return true;
  }
  function validTrial(t) {
    if (!t || typeof t !== 'object' || Array.isArray(t) || !realDate(t.date)) return false;
    if (t.taskId != null && (typeof t.taskId !== 'string' || !ID.test(t.taskId))) return false;
    if (!Number.isInteger(t.before) || t.before <= 0 || t.before > 1440 || !Number.isInteger(t.after) || t.after < 0 || t.after > 1440) return false;
    if (t.quality != null && ['accepted', 'pending', 'rework'].indexOf(t.quality) < 0) return false;
    if (!optionalBoolean(t, 'usedAI') || !optionalBoolean(t, 'confirmed') || !optionalText(t, 'title', 200) || !optionalText(t, 'method', 2000) || !optionalText(t, 'category', 64)) return false;
    if (t.id != null && (typeof t.id !== 'string' || !ID.test(t.id)) || !optionalEnum(t, 'baseline', ['plan']) || !optionalEnum(t, 'measurement', ['self-report'])) return false;
    if (!validCosts(t.costs, t.after) || !validLearning(t.learning) || !validModelEvidence(t)) return false;
    return true;
  }
  function migrateEntry(e) {
    // Legacy compatibility: old "blank" entries migrate to "stillness"; this is not a current product name.
    if (!e || typeof e !== 'object' || Array.isArray(e) || e.kind !== 'blank') return e;
    var out = copy(e); out.kind = 'stillness'; return out;
  }
  function validateState(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || input.v !== 1 || !Array.isArray(input.entries)) return { ok: false, error: 'state shape' };
    var entries = input.entries.map(migrateEntry), seen = Object.create(null);
    for (var i = 0; i < entries.length; i++) {
      if (!validEntry(entries[i], false)) return { ok: false, error: 'entry ' + i };
      if (seen[entries[i].id]) return { ok: false, error: 'duplicate entry' };
      seen[entries[i].id] = true;
    }
    if (input.drafts != null && !Array.isArray(input.drafts)) return { ok: false, error: 'drafts' };
    var drafts = input.drafts == null ? [] : input.drafts.map(migrateEntry);
    for (var j = 0; j < drafts.length; j++) if (!validEntry(drafts[j], true)) return { ok: false, error: 'draft ' + j };
    var trials = input.trials == null ? [] : input.trials;
    if (!Array.isArray(trials)) return { ok: false, error: 'trials' };
    for (var k = 0; k < trials.length; k++) if (!validTrial(trials[k])) return { ok: false, error: 'trial ' + k };
    var methods = input.methods == null ? [] : input.methods;
    if (!Array.isArray(methods)) return { ok: false, error: 'methods' };
    for (var mi = 0; mi < methods.length; mi++) if (!validMethod(methods[mi])) return { ok: false, error: 'method ' + mi };
    var methodUses = input.methodUses == null ? [] : input.methodUses;
    if (!Array.isArray(methodUses)) return { ok: false, error: 'methodUses' };
    for (var ui = 0; ui < methodUses.length; ui++) if (!validMethodUse(methodUses[ui])) return { ok: false, error: 'methodUse ' + ui };
    var wake = input.wake == null ? 960 : input.wake;
    if (!Number.isInteger(wake) || wake < 480 || wake > 1200) return { ok: false, error: 'wake' };
    if (!optionalText(input, 'name', 200) || !optionalText(input, 'uid', 64) || !optionalText(input, 'sortBy', 32) || !optionalBoolean(input, 'sound') || !optionalEnum(input, 'mode', ['demo', 'real'])) return { ok: false, error: 'settings' };
    if (input.pal != null && !integer(input.pal, 0, 6) || input.pv != null && !integer(input.pv, 0, 1000)) return { ok: false, error: 'settings' };
    if (input.fw != null && (!object(input.fw) || !Object.keys(input.fw).every(function (key) { return realDate(key) && integer(input.fw[key], 0, 1000000); }))) return { ok: false, error: 'fw' };
    if (input.ideal != null && (!object(input.ideal) || !['restore', 'create', 'connect', 'explore'].every(function (key) { return input.ideal[key] == null || integer(input.ideal[key], 0, 100); }))) return { ok: false, error: 'ideal' };
    if (!validAvailability(input.modelAvailability)) return { ok: false, error: 'model availability' };
    var out = pick(input, ['v', 'pv', 'mode', 'name', 'sound', 'pal', 'uid', 'sortBy']);
    out.entries = entries.map(cleanEntry); out.drafts = drafts.map(cleanEntry);
    out.trials = trials.map(function (t) { var trial = pick(t, ['id', 'taskId', 'date', 'title', 'before', 'after', 'method', 'category', 'confirmed', 'baseline', 'measurement']); var measurement = cleanMeasurement(t); Object.keys(measurement).forEach(function (key) { trial[key] = measurement[key]; }); return trial; });
    out.methods = methods.map(cleanMethod); out.methodUses = methodUses.map(cleanMethodUse);
    out.wake = wake; out.fw = input.fw == null ? {} : pick(input.fw, Object.keys(input.fw));
    out.ideal = input.ideal == null ? null : pick(input.ideal, ['restore', 'create', 'connect', 'explore']);
    if (input.modelAvailability != null) {
      out.modelAvailability = {};
      MODEL_IDS.forEach(function (key) { if (Object.prototype.hasOwnProperty.call(input.modelAvailability, key)) out.modelAvailability[key] = pick(input.modelAvailability[key], ['state', 'reason', 'checkedAt']); });
    }
    if (out.name == null) out.name = '';
    if (!out.sortBy) out.sortBy = 'prio';
    return { ok: true, state: out };
  }
  function privacyStatus(input) {
    input = input || {};
    var config = input.preferences || {};
    return {
      storage: input.memoryOnly === true ? 'memory-only' : 'browser-local',
      customModelConsent: config.consent === true,
      sessionKeyPresent: typeof config.key === 'string' && config.key.length > 0,
      legacyKeyPresent: input.legacyKeyPresent === true,
      hasBackup: input.hasBackup === true
    };
  }
  function diagnosticExport(input) {
    input = input || {};
    var state = input.state || {}, service = input.service || {};
    var error = input.lastError && input.lastError.code;
    var codes = ['TANGO_ORIGIN_REJECTED', 'TANGO_ORIGIN_REQUIRED', 'TANGO_METHOD_REJECTED', 'TANGO_AUDIO_WAV_REQUIRED', 'TANGO_AUDIO_TOO_LARGE', 'TANGO_INVALID_AUDIO', 'TANGO_LANGUAGE_UNAVAILABLE', 'TANGO_SPEECH_BUSY', 'TANGO_RECOGNITION_FAILED', 'TANGO_SERVICE_UNAVAILABLE', 'TANGO_STORAGE_FAILED', 'TANGO_IMPORT_INVALID', 'TANGO_EXPORT_FAILED', 'TANGO_MODEL_FAILED'];
    return {
      schema: 1,
      counts: { entries: Array.isArray(state.entries) ? state.entries.length : 0, drafts: Array.isArray(state.drafts) ? state.drafts.length : 0, trials: Array.isArray(state.trials) ? state.trials.length : 0, methods: Array.isArray(state.methods) ? state.methods.length : 0, methodUses: Array.isArray(state.methodUses) ? state.methodUses.length : 0 },
      privacy: privacyStatus(input),
      service: {
        status: ['ok', 'unavailable', 'checking'].indexOf(service.status) >= 0 ? service.status : 'unknown',
        version: typeof service.version === 'string' && /^\d+\.\d+\.\d+(?:-[a-z0-9.-]{1,40})?$/i.test(service.version) ? service.version : null,
        runtime: service.runtime === 'web-local' ? 'web-local' : 'unknown'
      },
      lastError: codes.indexOf(error) >= 0 ? error : null
    };
  }
  root.TangoPrivacy = { preferences: preferences, storablePreferences: storablePreferences, safeEndpoint: safeEndpoint, validateState: validateState, privacyStatus: privacyStatus, diagnosticExport: diagnosticExport };
}(window));
