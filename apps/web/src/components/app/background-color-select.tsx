"use client";

import { useEffect, useId, useState } from "react";
import { Input, Label, Select } from "@curvi/ui";
import type { ColorChoice, OutputChoices } from "@curvi/pipeline/output-options";
import {
  EDGE_MATCH_CHIP,
  EDGE_MATCH_LABEL,
  EDGE_MATCH_VALUE,
  colorChoiceFromValue,
  colorControlCopy,
  colorLabel,
  colorOptions,
  colorValue,
  darkColorNote,
  parseCustomHex,
  readRecentCustomColors,
  rememberCustomColor,
  writeRecentCustomColors,
  type FormColorChoice,
} from "@/lib/output-options-form";

interface BackgroundColorSelectProps {
  choice: ColorChoice;
  /** The choice resolved to a hex (white when a brand color is not available). */
  hex: string;
  background: OutputChoices["background"];
  brandColors: readonly string[];
  brandKitsAllowed: boolean;
  /** Match my photo's edges is picked (Keep only, PHASE_15 P1). */
  edgeMatch?: boolean;
  onChange: (choice: FormColorChoice) => void;
  /** The custom row's problem, so the form can hold the submit until it is fixed. */
  onProblem?: (problem: string | null) => void;
}

function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Background color (PHASE_15 control 3): a native Select, the best picker on
 * a phone, with a 24 px swatch chip that always names the color. "Custom
 * color" reveals a color input next to a hex field; the last three custom
 * colors are remembered in this browser.
 */
export function BackgroundColorSelect({
  choice,
  hex,
  background,
  brandColors,
  brandKitsAllowed,
  edgeMatch = false,
  onChange,
  onProblem,
}: BackgroundColorSelectProps) {
  const id = useId();
  const groups = colorOptions(brandColors, brandKitsAllowed);
  const copy = colorControlCopy(background);
  const [text, setText] = useState(choice.kind === "custom" ? choice.hex : hex);
  const [problem, setProblem] = useState<string | null>(null);
  const [recent, setRecent] = useState<string[]>([]);

  // Storage is read after mount, so the server markup and the first client
  // render agree.
  useEffect(() => {
    setRecent(readRecentCustomColors(browserStorage()));
  }, []);

  function report(next: string | null) {
    setProblem(next);
    onProblem?.(next);
  }

  function applyCustom(value: string) {
    setText(value);
    const parsed = parseCustomHex(value);
    if (!parsed.ok) {
      report(parsed.error);
      return;
    }
    report(null);
    onChange({ kind: "custom", hex: parsed.hex });
    const next = rememberCustomColor(recent, parsed.hex);
    setRecent(next);
    writeRecentCustomColors(browserStorage(), next);
  }

  function pick(value: string) {
    if (value === EDGE_MATCH_VALUE) {
      report(null);
      onChange({ kind: "edge_match" });
      return;
    }
    if (value === "custom") {
      const start = recent[0] ?? hex;
      setText(start);
      report(null);
      onChange({ kind: "custom", hex: start });
      return;
    }
    const next = colorChoiceFromValue(value);
    if (next) {
      report(null);
      onChange(next);
    }
  }

  const keepEdges = edgeMatch && background === "keep";
  const note = keepEdges ? null : darkColorNote(choice, hex, background);
  const typed = parseCustomHex(text);
  // The color input takes lower case #rrggbb only.
  const pickerHex = (typed.ok ? typed.hex : hex).toLowerCase();
  const selectId = `${id}-color`;
  const hexId = `${id}-hex`;
  const errorId = `${id}-hex-error`;

  return (
    <div data-testid="background-color">
      <Label htmlFor={selectId}>{copy.label}</Label>
      {copy.helper ? <p className="mt-0.5 text-xs text-ink-500">{copy.helper}</p> : null}
      <div className="mt-1.5 flex items-center gap-3">
        <Select
          id={selectId}
          value={keepEdges ? EDGE_MATCH_VALUE : colorValue(choice)}
          onChange={(event) => pick(event.target.value)}
          className="min-w-0 flex-1 [&_select]:h-11"
          data-testid="color-select"
        >
          {groups.swatches.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
          {groups.brand.length > 0 ? (
            <optgroup label="Your brand colors">
              {groups.brand.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ) : null}
          <option value="custom">Custom color</option>
          {background === "keep" ? <option value={EDGE_MATCH_VALUE}>{EDGE_MATCH_LABEL}</option> : null}
        </Select>
        <span className="flex max-w-[45%] shrink-0 items-center gap-2 text-xs text-ink-700" data-testid="color-chip">
          {keepEdges ? null : (
            <span
              aria-hidden="true"
              className="size-6 shrink-0 rounded-md ring-1 ring-inset ring-ink-950/20"
              style={{ backgroundColor: hex }}
            />
          )}
          <span className="truncate">{keepEdges ? EDGE_MATCH_CHIP : colorLabel(choice, hex)}</span>
        </span>
      </div>
      {choice.kind === "custom" && !keepEdges ? (
        <div className="mt-3" data-testid="custom-color">
          <Label htmlFor={hexId}>Color code</Label>
          <div className="mt-1 flex items-center gap-2">
            <input
              type="color"
              aria-label="Pick a custom color"
              value={pickerHex}
              onChange={(event) => applyCustom(event.target.value)}
              className="h-11 w-11 shrink-0 cursor-pointer rounded-lg border border-ink-200 bg-transparent p-1"
            />
            <Input
              id={hexId}
              value={text}
              inputMode="text"
              autoComplete="off"
              spellCheck={false}
              maxLength={7}
              placeholder="#1F2A44"
              aria-invalid={problem ? true : undefined}
              aria-describedby={problem ? errorId : undefined}
              onChange={(event) => applyCustom(event.target.value)}
              className="h-11 min-w-0 flex-1 font-mono uppercase"
              data-testid="custom-hex"
            />
          </div>
          {problem ? (
            <p id={errorId} className="mt-1 text-xs text-red-600" role="alert">
              {problem}
            </p>
          ) : null}
          {recent.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-2" data-testid="recent-colors">
              <span className="text-xs text-ink-500">Recent</span>
              {recent.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => applyCustom(color)}
                  className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-xs text-ink-700 hover:bg-ink-50"
                >
                  <span
                    aria-hidden="true"
                    className="size-5 rounded ring-1 ring-inset ring-ink-950/20"
                    style={{ backgroundColor: color }}
                  />
                  {color}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {note ? (
        <p className="mt-2 text-xs text-amber-700" data-testid="dark-color-note">
          {note}
        </p>
      ) : null}
    </div>
  );
}
