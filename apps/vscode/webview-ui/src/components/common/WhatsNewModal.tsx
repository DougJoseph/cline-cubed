import React from "react"
import Markdown from "react-markdown"
import { Dialog, DialogContent } from "@/components/ui/dialog"

interface WhatsNewModalProps {
	open: boolean
	onClose: () => void
	version: string
	/** The fork's CHANGELOG entry for the running version, as markdown — shipped in the package. */
	notes: string
}

/**
 * Cline Cubed: the What's New modal, opened on the chat home after a version change. It shows the
 * fork's own notes for the running version and nothing else. Stock rendered banners fetched from
 * Cline's server here, with a row of Cline's community links beneath them; neither is the fork's,
 * so neither appears.
 */
const WhatsNewModal: React.FC<WhatsNewModalProps> = ({ open, onClose, version, notes }) => {
	const inlineCodeStyle: React.CSSProperties = {
		backgroundColor: "var(--vscode-textCodeBlock-background)",
		padding: "2px 6px",
		borderRadius: "3px",
		fontFamily: "var(--vscode-editor-font-family)",
		fontSize: "0.9em",
	}

	return (
		<Dialog onOpenChange={(isOpen) => !isOpen && onClose()} open={open}>
			<DialogContent
				aria-describedby="whats-new-description"
				aria-labelledby="whats-new-title"
				className="pt-5 px-5 pb-4 gap-0">
				<div id="whats-new-description">
					<h2
						className="text-lg font-semibold mb-3 pr-6"
						id="whats-new-title"
						style={{ color: "var(--vscode-editor-foreground)" }}>
						New in Cline Cubed {version}
					</h2>

					<div
						className="text-sm max-h-[60vh] overflow-y-auto"
						style={{ color: "var(--vscode-descriptionForeground)" }}>
						<Markdown
							components={{
								a: ({ href, children }) => (
									<a
										href={href}
										rel="noopener noreferrer"
										style={{ color: "var(--vscode-textLink-foreground)" }}
										target="_blank">
										{children}
									</a>
								),
								code: ({ children }) => <code style={inlineCodeStyle}>{children}</code>,
								h3: ({ children }) => (
									<h3
										className="text-sm font-semibold mt-3 mb-1"
										style={{ color: "var(--vscode-editor-foreground)" }}>
										{children}
									</h3>
								),
								li: ({ children }) => <li className="mb-2">{children}</li>,
								ul: ({ children }) => <ul className="pl-4 list-disc">{children}</ul>,
							}}>
							{notes}
						</Markdown>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}

export default WhatsNewModal
