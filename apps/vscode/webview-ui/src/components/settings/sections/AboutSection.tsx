import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import iconUrl from "../../../assets/icon.svg"
import Section from "../Section"

interface AboutSectionProps {
	version: string
	extensionVariant?: "legacy" | "next"
	renderSectionHeader: (tabId: string) => JSX.Element | null
}

const VARIANT_LABELS: Record<"legacy" | "next", string> = {
	legacy: "Legacy",
	next: "Next",
}

const AboutSection = ({ version, extensionVariant, renderSectionHeader }: AboutSectionProps) => {
	return (
		<div>
			{renderSectionHeader("about")}
			<Section>
				<div className="flex px-4 flex-col gap-2">
					<img alt="Cline Cubed" height={64} src={iconUrl} width={64} />
					<h2 className="text-lg font-semibold">
						Cline Cubed v{version}
						{extensionVariant && (
							<span className="ml-2 text-sm font-normal text-description">
								({VARIANT_LABELS[extensionVariant]})
							</span>
						)}
					</h2>
					<p>
						Cline Cubed is a fork of Cline with three working modes — Plan, Act, and Image. Image Mode adds a
						dedicated image-aware channel: when your Plan or Act model is text-only, the bridge routes images to the
						Image Mode model so you can still work from screenshots and designs.
					</p>

					<h3 className="text-md font-semibold">Development</h3>
					<p>
						<VSCodeLink href="https://github.com/DougJoseph/cline-cubed">GitHub</VSCodeLink>
						{" • "}
						<VSCodeLink href="https://github.com/DougJoseph/cline-cubed/issues"> Issues</VSCodeLink>
					</p>

					<h3 className="text-md font-semibold">Resources</h3>
					<p>
						<VSCodeLink href="https://docs.cline.bot/">Documentation</VSCodeLink>
					</p>
				</div>
			</Section>
		</div>
	)
}

export default AboutSection
