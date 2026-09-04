import { ExtensionRegistryInfo } from "@/registry"

/**
 * The id of the current release's What's New notes: the full extension version.
 *
 * Cline Cubed: stock used the major.minor part, so a patch release announced nothing. Every fork
 * release is a patch bump, so the id is the whole version — any version change is a new
 * announcement, and `lastShownAnnouncementId` records the exact version whose notes were seen.
 */
export function getLatestAnnouncementId(): string {
	return ExtensionRegistryInfo.version
}
