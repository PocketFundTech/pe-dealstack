// Shared useApiQuery cache keys for the settings page. Several sections each
// used to fetch these endpoints independently (page.tsx + FirmProfileSection
// both hit /users/me; SecuritySection.trust, SecuritySection.staffAccessLog,
// and TeamSection.requireMfa all hit /organizations/me), fanning one page
// load out into ~13 requests with /users/me and /organizations/me each fired
// 3x. Importing these constants instead of the literal path string means
// every section shares one cached request per key (useApiQuery dedupes
// concurrent callers of the same key) and one mutation can refresh every
// subscriber via mutateApiCache/invalidateApiCache.
export const USERS_ME_KEY = "/users/me";
export const ORGANIZATIONS_ME_KEY = "/organizations/me";
