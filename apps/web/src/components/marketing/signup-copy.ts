import { freeCredits, freeCreditsReach } from "@/lib/marketing-facts";

/**
 * The signup page lead. Every hero call to action lands here, so it states
 * the free grant from the tier seed and only what that grant covers today.
 */
export function signupLead(): string {
  return `Start free with ${freeCredits()} credits, ${freeCreditsReach()}. No card needed.`;
}
