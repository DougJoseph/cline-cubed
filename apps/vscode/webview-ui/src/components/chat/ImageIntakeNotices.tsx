import { dismissImageIntakeNotices, useImageIntakeNotices } from "@/utils/imageIntake"

/** Says what happened to an image that could not be attached as it was. */
export const ImageIntakeNotices = () => {
	const notices = useImageIntakeNotices()
	if (notices.length === 0) {
		return null
	}
	return (
		<div
			className="mx-3.5 mt-2 flex items-start gap-2 rounded-xs border border-error px-2 py-1 text-xs text-error"
			role="alert">
			<div className="flex-1">
				{notices.map((notice) => (
					<div key={notice}>{notice}</div>
				))}
			</div>
			<button
				aria-label="Dismiss image message"
				className="cursor-pointer border-0 bg-transparent p-0 text-error"
				onClick={dismissImageIntakeNotices}
				type="button">
				<span className="codicon codicon-close" />
			</button>
		</div>
	)
}
