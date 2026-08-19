// Bolding the matched letters. Used by the sidebar and the command palette so
// both mark them the same way.

/// `positions` are counted against the text that was matched; positions outside
/// `label` are ignored, so a label that is a prefix of the searched text stays
/// safe.
export function mark(label, positions) {
  const frag = document.createDocumentFragment();
  const set = new Set((positions || []).filter((p) => p < label.length));
  if (!set.size) {
    frag.appendChild(document.createTextNode(label));
    return frag;
  }
  let plain = '';
  for (let i = 0; i < label.length; i++) {
    if (set.has(i)) {
      if (plain) {
        frag.appendChild(document.createTextNode(plain));
        plain = '';
      }
      const b = document.createElement('b');
      b.textContent = label[i];
      frag.appendChild(b);
    } else {
      plain += label[i];
    }
  }
  if (plain) frag.appendChild(document.createTextNode(plain));
  return frag;
}
