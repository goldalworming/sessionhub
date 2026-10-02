// Reorder a list's items by dragging them — with a mouse, a pen or a finger.
//
// Pointer events rather than HTML drag and drop: the latter does nothing on a
// touch screen, and the tablet and the phone are where this is wanted as much
// as anywhere. The items move live under the pointer; `onDrop` hears the new
// order once, when something actually moved.
//
// Started three ways, so it never takes over a gesture meant as something else:
// - from a `handle`, at once (the handle exists only to be dragged);
// - with a mouse, after it has moved a few pixels — a click stays a click;
// - with a finger, after a short hold — a swipe stays a scroll.

const MOUSE_SLOP = 5;
const TOUCH_HOLD_MS = 350;
const TOUCH_SLOP = 8;

/// `selector` picks the items (direct children of one parent); `key(el)` names
/// one; `fixed` marks items that never move and that nothing goes before (the
/// local machine's tab); `axis` is 'x' or 'y'; `enabled()` is asked at the
/// start of each drag.
export function dragOrder(container, { selector, key, axis, onDrop, handle = null, fixed = null, enabled = () => true }) {
  container.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !enabled()) return;
    const item = e.target.closest(selector);
    if (!item || !container.contains(item)) return;
    if (fixed && item.matches(fixed)) return;
    if (handle && !e.target.closest(handle)) return;

    const parent = item.parentElement;
    const movable = () => [...parent.children].filter((c) => c.matches(selector) && !(fixed && c.matches(fixed)));
    const before = movable().map(key).join('\0');
    const at = (ev) => (axis === 'x' ? ev.clientX : ev.clientY);
    const x0 = e.clientX;
    const y0 = e.clientY;
    const touch = e.pointerType === 'touch';
    let armed = !!handle;
    let dragging = false;
    let hold = null;
    if (touch && !armed) hold = setTimeout(() => (armed = true), TOUCH_HOLD_MS);

    // Once a finger has armed a drag, the page must not scroll under it.
    const noScroll = (ev) => armed && ev.cancelable && ev.preventDefault();
    document.addEventListener('touchmove', noScroll, { passive: false });

    const move = (ev) => {
      const dist = Math.hypot(ev.clientX - x0, ev.clientY - y0);
      if (!armed) {
        if (touch) {
          // Moved before the hold completed: that was a scroll.
          if (dist > TOUCH_SLOP) end();
          return;
        }
        if (dist < MOUSE_SLOP) return;
        armed = true;
      }
      if (!dragging) {
        dragging = true;
        item.classList.add('dragging');
        try {
          item.setPointerCapture(ev.pointerId);
        } catch {
          // capture is a nicety; the listeners are on the document anyway
        }
      }
      const p = at(ev);
      const others = movable().filter((c) => c !== item);
      const next = others.find((c) => {
        const r = c.getBoundingClientRect();
        return p < (axis === 'x' ? r.left + r.width / 2 : r.top + r.height / 2);
      });
      if (next) {
        if (item.nextElementSibling !== next) parent.insertBefore(item, next);
      } else if (others.length) {
        const last = others[others.length - 1];
        if (last.nextElementSibling !== item) parent.insertBefore(item, last.nextElementSibling);
      }
    };

    const end = () => {
      clearTimeout(hold);
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', end);
      document.removeEventListener('pointercancel', end);
      document.removeEventListener('touchmove', noScroll);
      if (!dragging) return;
      item.classList.remove('dragging');
      // The click that ends a drag is not a click on the item.
      const swallow = (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      container.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => container.removeEventListener('click', swallow, { capture: true }), 0);
      const after = movable().map(key);
      if (after.join('\0') !== before) onDrop(after);
    };

    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
  });
}
