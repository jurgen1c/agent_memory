export function resolveStudentOAuthIdentity({ providerUserId, tenantId }) {
  if (!tenantId) {
    throw new Error("tenantId is required for student OAuth identity resolution");
  }

  return {
    providerUserId,
    tenantId,
    uid: `${tenantId}:${providerUserId}`
  };
}
