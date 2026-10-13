// Floating menus, ported from libre/gui/web: the shared popover (PopoverMenu), the themed
// dropdown that replaces native <select> (Select), and the right-click menu (ContextMenu).
import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { METHODS } from '../lib/model.js';

// Keys shared by every floating menu. Runs in the capture phase so Escape
// closes only the menu, not a dialog or pane listening on window behind it.
function menuKeyDown(event, menu, onClose) {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    onClose();
    return;
  }
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const items = Array.from(menu.querySelectorAll('button:not(:disabled)'));
  if (!items.length) return;
  event.preventDefault();
  event.stopPropagation();
  const at = items.indexOf(document.activeElement);
  const step = event.key === 'ArrowDown' ? 1 : -1;
  const next = at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
  items[next].focus();
}

// Puts focus on the picked item, or the first one, so arrows start from there.
function focusMenu(menu) {
  const item = menu.querySelector('button[aria-checked="true"]:not(:disabled)') ?? menu.querySelector('button:not(:disabled)');
  item?.focus({ preventScroll: true });
  item?.scrollIntoView({ block: 'nearest' });
}

export function PopoverMenu({ open, anchor, placement = 'below', minWidth = 180, onClose, children, className = '' }) {
  const menuRef = useRef(null);

  useLayoutEffect(() => {
    if (!open || !anchor) return undefined;
    const menu = menuRef.current;
    if (!menu) return undefined;
    function place() {
      const rect = anchor.getBoundingClientRect();
      const width = Math.max(rect.width, minWidth);
      const height = menu.offsetHeight;
      let top = placement === 'above' ? rect.top - height - 8 : rect.bottom + 8;
      if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 8);
      if (top < 8) top = Math.min(rect.bottom + 8, window.innerHeight - height - 8);
      let left = rect.left;
      if (left + width > window.innerWidth - 8) left = window.innerWidth - width - 8;
      if (left < 8) left = 8;
      menu.style.top = `${top}px`;
      menu.style.left = `${left}px`;
      menu.style.width = `${width}px`;
    }
    place();
    function onPointer(event) {
      if (menu.contains(event.target) || anchor.contains(event.target)) return;
      onClose();
    }
    const onKey = (event) => menuKeyDown(event, menu, onClose);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, anchor, placement, minWidth, onClose]);

  // Only when the menu opens: later renders must not pull focus back into it.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || !menu) return undefined;
    focusMenu(menu);
    return () => {
      if (menu.contains(document.activeElement)) anchor?.focus({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div ref={menuRef} className={`menu-popover glass menu-floating ${className}`} role="menu">
      {children}
    </div>,
    document.body,
  );
}

// The app's dropdown. A native <select> opens an OS-drawn list that ignores the
// theme, so every picker goes through this trigger and the shared popover.
// options: [{ value, label, disabled? }]
export function Select({ value, options, onChange, display, ariaLabel, title, disabled, minWidth, placement, className = '' }) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);
  const current = options.find((o) => o.value === value);
  return (
    <>
      <button
        ref={triggerRef}
        className={`menu-trigger ${className}`}
        type="button"
        aria-label={ariaLabel}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((shown) => !shown)}
        onKeyDown={(event) => {
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="tree-name">{display ?? current?.label ?? ''}</span>
      </button>
      <PopoverMenu open={open} anchor={triggerRef.current} minWidth={minWidth} placement={placement} onClose={() => setOpen(false)}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            role="menuitemradio"
            aria-checked={o.value === value}
            disabled={o.disabled}
            onClick={() => {
              setOpen(false);
              triggerRef.current?.focus({ preventScroll: true });
              onChange(o.value);
            }}
          >
            <span className="tree-name">{o.label}</span>
          </button>
        ))}
      </PopoverMenu>
    </>
  );
}

// Right-click / "more" menu at a point. items: [{ label, onClick, danger?, disabled? } | { sep: true }]
export function ContextMenuAt({ x, y, items, onClose }) {
  const menuRef = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return undefined;
    function place() {
      let left = x;
      let top = y;
      if (left + menu.offsetWidth > window.innerWidth - 8) left = window.innerWidth - menu.offsetWidth - 8;
      if (top + menu.offsetHeight > window.innerHeight - 8) top = window.innerHeight - menu.offsetHeight - 8;
      menu.style.left = `${Math.max(8, left)}px`;
      menu.style.top = `${Math.max(8, top)}px`;
    }
    place();
    function onPointer(event) {
      if (!menu.contains(event.target)) closeRef.current();
    }
    const onKey = (event) => menuKeyDown(event, menu, () => closeRef.current());
    const onBlur = () => closeRef.current();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [x, y]);

  useLayoutEffect(() => {
    if (menuRef.current) focusMenu(menuRef.current);
  }, []);

  return createPortal(
    <div ref={menuRef} className="menu-popover glass menu-floating" role="menu" style={{ top: y, left: x }}>
      {items.map((it, i) =>
        it.sep ? (
          <div key={i} className="menu-sep" role="separator" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={it.danger ? 'danger' : ''}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
          >
            <span className="tree-name">{it.label}</span>
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

// HTTP method picker: the trigger and each option wear the method's color.
export function MethodSelect({ value, onChange, disabled }) {
  return (
    <Select
      className={`method-select m-${value}`}
      value={value}
      disabled={disabled}
      minWidth={130}
      onChange={onChange}
      options={METHODS.map((m) => ({ value: m, label: <span className={`method-opt m-${m}`}>{m}</span> }))}
    />
  );
}
