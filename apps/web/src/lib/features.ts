/**
 * Product features that exist in code but are not offered yet. A flag stays
 * false until the feature really works end to end in production, so the app
 * never offers something it cannot deliver (Phase 10 decision 1).
 */

/**
 * Concept Mode (text only renders with a visible Concept render label) needs
 * a concept text to image recipe and the corner label overlay in the
 * pipeline. Neither ships yet: a text only pack would end with no files, and
 * a photo pack would deliver composites without the label. While this is
 * false the new pack form hides the Concept option and the service rejects
 * mode "concept". The UI and service code paths stay in place for the day it
 * flips.
 */
export const CONCEPT_MODE_AVAILABLE = false;
