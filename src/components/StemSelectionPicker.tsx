import { useId, type CSSProperties } from "react";

import {
  STEM_SELECTION_PRESETS,
  moveStemSelection,
  normalizeStemSelection,
  stemSelectionForPreset,
  toggleStemSelection,
  type StemSelection,
} from "../lib/stemSelection";
import {
  AUDIO_STEM_IDS,
  stemPresentationFor,
  type AudioStemId,
} from "../lib/stems";
import styles from "./StemSelectionPicker.module.css";

export type StemSelectionPickerProps = {
  value: StemSelection;
  onChange: (selection: StemSelection) => void;
  disabled?: boolean;
  heading?: string;
  className?: string;
};

export function StemSelectionPicker({
  value,
  onChange,
  disabled = false,
  heading = "Stem layout",
  className = "",
}: StemSelectionPickerProps) {
  const headingId = useId();
  const selection = normalizeStemSelection(value);
  const selected = new Set(selection.stemIds);
  const orderedIds: AudioStemId[] = [
    ...selection.stemIds,
    ...AUDIO_STEM_IDS.filter((id) => !selected.has(id)),
  ];

  return (
    <section
      className={[styles.picker, className].filter(Boolean).join(" ")}
      aria-labelledby={headingId}
    >
      <div className={styles.headingRow}>
        <h3 id={headingId}>{heading}</h3>
        <output className={styles.summary} aria-live="polite">
          {selection.stemIds.length} selected
        </output>
      </div>

      <div className={styles.presets} role="group" aria-label="Stem count preset">
        {STEM_SELECTION_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={selection.mode === preset.id ? styles.activePreset : styles.preset}
            aria-pressed={selection.mode === preset.id}
            title={preset.description}
            disabled={disabled}
            onClick={() => onChange(stemSelectionForPreset(preset.id))}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <p className={styles.hint}>
        Choose a preset or customize the channels and playback order.
      </p>

      <ol className={styles.stemList}>
        {orderedIds.map((stemId) => {
          const presentation = stemPresentationFor(stemId);
          const selectedIndex = selection.stemIds.indexOf(stemId);
          const isSelected = selectedIndex >= 0;
          return (
            <li
              key={stemId}
              className={isSelected ? styles.selectedStem : styles.stem}
              style={{ "--selection-color": presentation.color } as CSSProperties}
            >
              <label className={styles.checkLabel}>
                <input
                  type="checkbox"
                  checked={isSelected}
                  disabled={disabled || (isSelected && selection.stemIds.length === 1)}
                  onChange={() => onChange(toggleStemSelection(selection, stemId))}
                />
                <span className={styles.shortLabel} aria-hidden="true">
                  {presentation.shortLabel}
                </span>
                <span>{presentation.label}</span>
              </label>

              {isSelected && (
                <span className={styles.orderControls}>
                  <button
                    type="button"
                    aria-label={`Move ${presentation.label} earlier`}
                    disabled={disabled || selectedIndex === 0}
                    onClick={() => onChange(moveStemSelection(selection, stemId, -1))}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${presentation.label} later`}
                    disabled={disabled || selectedIndex === selection.stemIds.length - 1}
                    onClick={() => onChange(moveStemSelection(selection, stemId, 1))}
                  >
                    ↓
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default StemSelectionPicker;
