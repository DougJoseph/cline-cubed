import iconUrl from "./icon.svg"

/**
 * The Cline Cubed PAGE MARK — the chat home, onboarding and welcome screens.
 *
 * Two treatments exist and they are not interchangeable. This is the page mark: two-tone, with
 * its own backdrop, so one file reads on any theme. The NAV mark (`assets/icons/nav-icon*.svg`)
 * is the other: compact, single-ink, no backdrop, supplied as a light/dark pair that VS Code
 * picks between. Putting a bare nav treatment here renders dark-on-dark and disappears.
 */
const ClineCubedIcon = ({ className }: { className?: string }) => <img alt="Cline Cubed" className={className} src={iconUrl} />

export default ClineCubedIcon
