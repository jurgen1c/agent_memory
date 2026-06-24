export function requireTenant(request) {
  const tenantId = request.headers["x-tenant-id"];

  if (!tenantId) {
    throw new Error("missing tenant");
  }

  return tenantId;
}
