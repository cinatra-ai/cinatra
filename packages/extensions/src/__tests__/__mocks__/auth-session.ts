export const getAuthSession = async () => null;
export const isPlatformAdmin = () => false;
export const requireAdminSession = async () => {};
export const requireAuthSession = async () => ({ user: { id: "test", role: "admin" } });
export const buildCanDoOptsFromSession = () => ({});
