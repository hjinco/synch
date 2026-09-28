// Organization management depends on role; sharing actions check plan entitlement.
window.synchOrganizationUI = {
  canManage(organization) {
    return ["owner", "admin"].includes(organization?.role);
  },
};
