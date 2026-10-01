const validationReasons: Readonly<Record<string, string>> = {
  AUTHENTICATION: "The provider rejected this key. Replace it or check its permissions.",
  RATE_LIMIT: "The provider rate limit was reached. Try validating again later.",
  TIMEOUT: "Provider validation timed out. Try validating again.",
  UNAVAILABLE: "The provider could not be reached. Try validating again.",
  BAD_RESPONSE: "The provider returned an unusable response. Try validating again.",
  POLICY: "Provider validation is not configured. Contact the administrator.",
  VALIDATION_INCOMPLETE: "Validation did not complete. Select Validate to check this stored key.",
};

export function credentialValidationReason(status: string, failureCode?: string | null) {
  if (status === "pending_validation") return validationReasons.VALIDATION_INCOMPLETE;
  if (status === "active" || status === "disabled" || status === "revoked") return null;
  return validationReasons[failureCode ?? ""] ?? "Validation could not be completed. Try validating again.";
}
