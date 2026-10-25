// Home integration slots: stable DOM contract for story banner and next actions.
export const HOME_SLOT_IDS = Object.freeze([
  'relay-home-banner',
  'relay-home-next',
]);

export function renderHomeSlots() {
  return '<section id="relay-home-banner" data-slot="story-banner" aria-label="时光故事书"></section>'
    + '<section id="relay-home-next" data-slot="next-actions" aria-label="接下来的事"></section>';
}

export function hasHomeSlots(markup) {
  const text = String(markup || '');
  return HOME_SLOT_IDS.every((id) => text.includes('id="' + id + '"'));
}
