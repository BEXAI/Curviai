export {
  RecipeModelOptions,
  RecipeRow,
  adCopyRecipe,
  addedOverlaysIntake,
  aplusCopyRecipe,
  qcJudgePolicy,
  recipeSeedRows,
  restrictedGoodsIntake,
  servesTraffic,
  servingRecipeSeedRow,
} from "./recipes";
export { RESTRICTED_GOODS_KEYS, isRestrictedGoodsKey, restrictedGoods } from "./restricted-goods";
export type { RestrictedGoodsKey } from "./restricted-goods";
export {
  QUESTION_KINDS,
  channelChoices,
  defaultChannelChoices,
  defaultMoodChoices,
  moodChoices,
  questionSet,
} from "./questions";
export type { ChannelChoice, MoodChoice, QuestionKind } from "./questions";
export {
  CUTOUT_TASK,
  HARMONIZE_TASK,
  SCENE_PLATE_TASK,
  costCaps,
  spendCapPolicy,
  imageModelSeedRows,
  llmImageTokenMultipliers,
  llmModelEfforts,
  llmModelPrices,
  llmModelProviders,
  cutoutModelSeedRows,
} from "./models";
export type {
  CutoutModelSeedRow,
  ImageModelSeedRow,
  ImageProviderFamily,
  LlmEffortLevel,
  LlmPriceTable,
  LlmProviderFamily,
} from "./models";
export {
  adsFormats,
  aplusCopy,
  aplusModules,
  backgroundSwatches,
  badgeStyle,
  canvasDefaults,
  jpegEncoding,
  lifestyleFallbackScenes,
  originalFit,
  packBundles,
  presets,
  sceneCountOptions,
  sceneDefaults,
  stillStyle,
  templates,
} from "./templates";
export { variationOptions } from "./variations";
// Phase 18 growth numbers: one section per lane in growth.ts. A star export,
// so lanes add exports there without touching this file.
export * from "./growth";
export {
  falBalanceAccounts,
  falBalanceLines,
  falBalanceProbePolicy,
  llmCreditWindows,
  llmFallbackAlertPolicy,
  llmQuotaAlertFamilies,
  providerAlertPolicy,
  canaryPolicy,
  llmModelRetirements,
  llmRetirementWarningPolicy,
  activeRecipeModels,
  modelRetirementNotices,
} from "./monitoring";
export type {
  FalBalanceAccount,
  FalBalanceLines,
  FalBalanceProbePolicy,
  LlmCreditWindow,
  LlmFallbackAlertPolicy,
  LlmModelRetirement,
} from "./monitoring";
export type {
  CarouselBeat,
  AplusModuleKey,
  AplusModuleLayout,
  AplusModuleSeed,
  BackgroundSwatchKey,
  PackBundle,
  PackBundleKey,
  PresetKey,
} from "./templates";
export { DEFAULT_TEMPLATE_FONT, isTemplateFontKey, templateFonts } from "./fonts";
export type { TemplateFontEntry, TemplateFontKey } from "./fonts";
export { AUTO_STYLE_PRESET, MAX_BRAND_COLORS, brandPalette } from "./brand";
export { keepBackgroundPhrases } from "./phrases";
export { retentionOffers } from "./retention";
// Phase 20 P20-02 (Lane 1 Billing core), kept off the credits list below so
// lanes adding credits.ts names there do not edit the same lines.
export { billingReconcile } from "./credits";
// Phase 20 Lane 2 Billing terms (P20-05, P20-07), on their own line too.
export { renewalNotices, taxDisplay } from "./credits";
export type { RetentionOffers } from "./retention";
export {
  creditCosts,
  tiers,
  topUps,
  annualDiscountPct,
  creditExpiry,
  foundingMemberOffer,
  referralReward,
  tierByKey,
  featureStatus,
  tierEntitlements,
  shotMethodFeatures,
  channelFamilyFeatures,
  entitlementsFor,
  isEntitled,
  isFeatureLive,
  canUse,
  lowestTierWith,
  includesWithStatus,
  isShotMethodDeliverable,
  undeliverableShotMethods,
  platformSettingSeedRows,
  socialBadgeByTier,
} from "./credits";
export type {
  CreditCostKey,
  FeatureStatus,
  PlatformSettingSeedRow,
  TierDefinition,
  TierEntitlements,
  TierFeature,
  TierIncludeLine,
  TierKey,
  TopUp,
} from "./credits";
// Phase 20 seed files (docs/phases/PHASE_20.md, "Seed summary"). Re-exported
// whole, so a lane that adds a section exports it without editing this
// file. A name two of these files both export is a type error here
// (TS2308); a name also exported by name above silently loses to that one,
// so pick names that are new to the seed.
export * from "./operations";
export * from "./data-retention";
export * from "./disposable-domains";
export * from "./economics";
// PHASE_20 Lane 4 Observe (P20-13, P20-15): monitoring.ts is exported by
// name above, so its Phase 20 limits are listed here.
export { errorReportRetentionDays, errorReporting, healthLimits } from "./monitoring";
export type { ErrorReportingLimits, HealthLimits } from "./monitoring";
