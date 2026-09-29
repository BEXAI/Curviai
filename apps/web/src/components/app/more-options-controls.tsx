"use client";

import { useId } from "react";
import { Label, Select } from "@curvi/ui";
import {
  GRAPHICS_COLOR_HELPER,
  GRAPHICS_COLOR_LABEL,
  LOGO_LABEL,
  NEVER_ENLARGE_HELPER,
  NEVER_ENLARGE_LABEL,
  PHOTO_SHAPE_OPTIONS,
  PRODUCT_SIZE_LABEL,
  PRODUCT_SIZE_OPTIONS,
  SCENE_COUNT_LABEL,
  SCENE_STYLE_LABEL,
  TRIM_SHAPE_OPTION,
  formFit,
  isScenePresetChoice,
  moreOptionsVisibility,
  sceneCountFromValue,
  sceneCountSelectOptions,
  sceneCountValue,
  sceneStyleOptions,
  type FormFit,
  type OutputFormAction,
  type OutputFormState,
} from "@/lib/output-options-form";

interface MoreOptionsControlsProps {
  state: OutputFormState;
  onAction: (action: OutputFormAction) => void;
  /** The brand kit has a logo, so Logo on graphics shows. */
  hasLogo: boolean;
  /** Scenes are paused: Number of scenes is disabled and Scene style hidden. */
  scenesPaused: boolean;
}

/**
 * The controls inside More options (docs/phases/PHASE_15.md, UI item 7 and
 * the P1 table): Photo shape with Trim (Keep), Number of scenes, Scene
 * style, Logo on graphics, Product size (Remove), Never enlarge my photo
 * (Keep) and Graphics follow your color. Which ones show comes from
 * moreOptionsVisibility, and a hidden control never reaches the body.
 */
export function MoreOptionsControls({ state, onAction, hasLogo, scenesPaused }: MoreOptionsControlsProps) {
  const id = useId();
  const { choices, more } = state;
  const show = moreOptionsVisibility(choices, { hasLogo, scenesPaused });
  const fit = formFit(state);
  const shapeOptions: ReadonlyArray<{ value: FormFit; label: string; helper?: string }> = [...PHOTO_SHAPE_OPTIONS, TRIM_SHAPE_OPTION];

  return (
    <div className="space-y-5 px-4 pb-4" data-testid="more-options-controls">
      {show.photoShape ? (
        <fieldset data-testid="photo-shape">
          <legend className="text-sm font-medium text-ink-800">Photo shape</legend>
          <div className="mt-1 space-y-1">
            {shapeOptions.map((option) => (
              <label key={option.value} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2">
                <input
                  type="radio"
                  name={`${id}-photo-shape`}
                  value={option.value}
                  checked={fit === option.value}
                  onChange={() => onAction({ type: "fit", fit: option.value })}
                  className="h-5 w-5 shrink-0 accent-accent-600"
                />
                <span className="min-w-0">
                  <span className="block text-sm text-ink-800">{option.label}</span>
                  {option.helper ? <span className="block text-xs text-ink-500">{option.helper}</span> : null}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {show.sceneCount ? (
          <div>
            <Label htmlFor={`${id}-scenes`}>{SCENE_COUNT_LABEL}</Label>
            <Select
              id={`${id}-scenes`}
              value={scenesPaused ? "off" : sceneCountValue(state)}
              disabled={scenesPaused}
              onChange={(event) => {
                const count = sceneCountFromValue(event.target.value);
                if (count !== null) onAction({ type: "scenes", count });
              }}
              className="mt-1 [&_select]:h-11"
              data-testid="scene-count"
            >
              {sceneCountSelectOptions().map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        ) : null}

        {show.sceneStyle ? (
          <div>
            <Label htmlFor={`${id}-scene-style`}>{SCENE_STYLE_LABEL}</Label>
            <Select
              id={`${id}-scene-style`}
              value={more.scenePreset}
              onChange={(event) => {
                const value = event.target.value;
                if (isScenePresetChoice(value)) onAction({ type: "more", patch: { scenePreset: value } });
              }}
              className="mt-1 [&_select]:h-11"
              data-testid="scene-style"
            >
              {sceneStyleOptions().map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        ) : null}

        {show.productSize ? (
          <div>
            <Label htmlFor={`${id}-product-size`}>{PRODUCT_SIZE_LABEL}</Label>
            <Select
              id={`${id}-product-size`}
              value={more.productSize}
              onChange={(event) => {
                const size = PRODUCT_SIZE_OPTIONS.find((option) => option.value === event.target.value);
                if (size) onAction({ type: "more", patch: { productSize: size.value } });
              }}
              className="mt-1 [&_select]:h-11"
              data-testid="product-size"
            >
              {PRODUCT_SIZE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </div>

      {show.neverEnlarge ? (
        <CheckRow
          label={NEVER_ENLARGE_LABEL}
          helper={NEVER_ENLARGE_HELPER}
          checked={!more.enlarge}
          onChange={(checked) => onAction({ type: "more", patch: { enlarge: !checked } })}
          testId="never-enlarge"
        />
      ) : null}
      {show.logo ? (
        <CheckRow
          label={LOGO_LABEL}
          checked={more.logo}
          onChange={(checked) => onAction({ type: "more", patch: { logo: checked } })}
          testId="logo-on-graphics"
        />
      ) : null}
      {show.graphicsColor ? (
        <CheckRow
          label={GRAPHICS_COLOR_LABEL}
          helper={GRAPHICS_COLOR_HELPER}
          checked={more.graphicsColor}
          onChange={(checked) => onAction({ type: "more", patch: { graphicsColor: checked } })}
          testId="graphics-color"
        />
      ) : null}
    </div>
  );
}

function CheckRow({
  label,
  helper,
  checked,
  onChange,
  testId,
}: {
  label: string;
  helper?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  testId: string;
}) {
  return (
    <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg px-2 py-2 hover:bg-ink-50" data-testid={testId}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-5 w-5 shrink-0 rounded border-ink-300 accent-accent-600"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink-900">{label}</span>
        {helper ? <span className="block text-xs text-ink-500">{helper}</span> : null}
      </span>
    </label>
  );
}
