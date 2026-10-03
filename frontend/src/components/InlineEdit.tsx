/* Click-to-edit text field used for inline rename and the playlist
   header. Renders as plain text until activated; Enter commits, Esc cancels. */

import { useEffect, useRef, useState } from "react";

interface InlineEditProps {
  value: string;
  onCommit: (value: string) => void;
  className?: string;
  placeholder?: string;
  ariaLabel: string;
  /** Rendered text may span lines (playlist description). */
  multiline?: boolean;
  /** Empty commits are allowed (clearing artist/album in Organize);
      default refuses them — a title can never be empty. */
  allowEmpty?: boolean;
  /** Render straight into the editor (grid keyboard: Enter to edit). */
  startInEdit?: boolean;
}

export function InlineEdit({
  value,
  onCommit,
  className,
  placeholder,
  ariaLabel,
  multiline = false,
  allowEmpty = false,
  startInEdit = false,
}: InlineEditProps) {
  const [editing, setEditing] = useState(startInEdit);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (allowEmpty ? trimmed !== value : trimmed && trimmed !== value) {
      onCommit(trimmed);
    }
  };

  const cancel = () => {
    setDraft(value);
    setEditing(false);
  };

  if (!editing) {
    const Text = multiline ? "span" : "span";
    return (
      <Text
        className={`${className ?? ""} inlineedit__text`}
        onClick={(e) => {
          // A modifier-click is a selection gesture, not a rename:
          // Cmd/Ctrl/Alt/Shift never open the editor — the plain click
          // alone does.
          if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
          setEditing(true);
        }}
        title="Click to edit"
        role="button"
        tabIndex={0}
        aria-label={ariaLabel}
        onKeyDown={(e) => {
          if (e.key === "Enter") setEditing(true);
        }}
      >
        {value || <span className="inlineedit__placeholder">{placeholder}</span>}
      </Text>
    );
  }

  const shared = {
    ref: inputRef as never,
    className: `${className ?? ""} inlineedit__input`,
    value: draft,
    "aria-label": ariaLabel,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      setDraft(e.target.value),
    onBlur: commit,
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
    onKeyDown: (e: React.KeyboardEvent) => {
      // Enter commits in both modes (Shift+Enter = newline in multiline);
      // a blur-only commit silently loses the edit on unmount.
      if (e.key === "Enter" && (!multiline || !e.shiftKey)) {
        e.preventDefault();
        commit();
      }
      if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    },
  };
  return multiline ? <textarea rows={2} {...shared} /> : <input type="text" {...shared} />;
}
