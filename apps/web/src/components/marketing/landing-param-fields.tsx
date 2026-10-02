"use client";

import { useEffect, useState } from "react";
import { readLandingParams, type LandingParams } from "@/lib/attribution";

/**
 * Hidden inputs that carry the current page's landing params (UTM tags,
 * ref and the rest of LANDING_PARAM_KEYS, cleaned) on a GET form to
 * /signup, the form version of SignupLink (P18-01). The form's own source
 * field wins. Renders nothing on the server, so static pages stay static.
 */
export function LandingParamFields() {
  const [params, setParams] = useState<LandingParams>({});
  useEffect(() => {
    const { source: _ownSource, ...rest } = readLandingParams(window.location.href);
    setParams(rest);
  }, []);
  return (
    <>
      {Object.entries(params).map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
    </>
  );
}
