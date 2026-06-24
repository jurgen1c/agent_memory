export function resolveStudent(providerUserId, tenantId) {
  if (!tenantId) {
    throw new Error("tenantId is required");
  }

  return `${tenantId}:${providerUserId}`;
}
