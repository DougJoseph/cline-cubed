import { HistoryItem } from "@shared/HistoryItem"
import { StringRequest } from "@shared/proto/cline/common"
import {
	ArrowDownIcon,
	ArrowLeftIcon,
	ArrowRightIcon,
	ArrowUpIcon,
	DownloadIcon,
	InfoIcon,
	StarIcon,
	TrashIcon,
} from "lucide-react"
import { memo, useCallback, useMemo, useState } from "react"
import EditableChatTitle from "@/components/common/EditableChatTitle"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"
import { formatLargeNumber, formatSize } from "@/utils/format"

type HistoryViewItemProps = {
	item: HistoryItem
	pendingFavoriteToggles: Record<string, boolean>
	handleDeleteHistoryItem: (id: string) => void
	toggleFavorite: (id: string, isCurrentlyFavorited: boolean) => void
	/** Cline Cubed: refresh the list after a rename — the list fetches its own rows. */
	onRenamed?: () => void
	/** Cline Cubed: override what opening a row does. The chats list passes this so a click asks
	 *  the HOST to open the chat elsewhere; without it a row binds THIS webview to the task, which
	 *  is right inside a chat and wrong in a list that has no conversation of its own. */
	onSelectTask?: (id: string) => void
}

/** Cline Cubed row (2026-08-28, Doug): clicking the row OPENS the chat; everything else is an
 *  icon at the right that appears on hover — info (this row's details), favorite, delete. The
 *  stock pattern this replaces was select-a-checkbox-then-press-a-full-width-red-button, which
 *  put two unlabeled click targets in every row and a destructive control under the list. */
const ICON_REVEAL = "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100"

const HistoryViewItem = ({
	item,
	pendingFavoriteToggles,
	handleDeleteHistoryItem,
	toggleFavorite,
	onSelectTask,
	onRenamed,
}: HistoryViewItemProps) => {
	const [expanded, setExpanded] = useState(false)

	const isFavoritedItem = useMemo(
		() => pendingFavoriteToggles[item.id] ?? item.isFavorited,
		[item.id, item.isFavorited, pendingFavoriteToggles],
	)

	const { setSurfaceBoundTaskId, navigateToChat } = useExtensionState()

	const handleShowTaskWithId = useCallback(
		(id: string) => {
			if (onSelectTask) {
				// Cline Cubed: the chats list owns this click — it opens the chat in a real chat
				// surface, not here.
				onSelectTask(id)
				return
			}
			// Cline Cubed: this webview chose the task — bind to it so its broadcast renders
			// here and no other open chat surface switches to it, and navigate THIS surface to
			// the chat view. The navigation is local on purpose: the RPC is unary and carries no
			// surface identity, so the host-side chatButtonClicked it used to fire was aimed at
			// the ACTIVE surface — a guess that could navigate a different chat.
			setSurfaceBoundTaskId(id)
			navigateToChat()
			TaskServiceClient.showTaskWithId(StringRequest.create({ value: id })).catch((error) =>
				console.error("Error showing task:", error),
			)
		},
		[setSurfaceBoundTaskId, navigateToChat, onSelectTask],
	)

	const formatDate = useCallback((timestamp: number) => {
		const date = new Date(timestamp)
		const today = new Date()
		const isToday = today.toDateString() === date.toDateString()

		return date
			.toLocaleString(
				"en-US",
				isToday
					? {
							hour: "numeric",
							minute: "2-digit",
							hour12: true,
						}
					: {
							month: "long",
							day: "numeric",
							hour: "numeric",
							minute: "2-digit",
							hour12: true,
						},
			)
			.replace(", ", " ")
			.replace(" at", ",")
	}, [])

	return (
		<div className="history-item group flex flex-col mb-1 border-b border-accent/10 hover:bg-list-hover" key={item.id}>
			{/* The row itself is the OPEN target — one click, one outcome. */}
			<div
				className="flex items-start gap-2 px-3 py-2 cursor-pointer min-w-0"
				onClick={(e) => {
					e.stopPropagation()
					handleShowTaskWithId(item.id)
				}}>
				<div className="flex flex-col gap-1 flex-grow min-w-0">
					<div className="flex items-center gap-2 min-w-0">
						<div className="overflow-hidden flex-1 min-w-0">
							<EditableChatTitle
								className="line-clamp-1 break-words whitespace-pre-wrap ph-no-capture"
								fallback={item.task}
								onRenamed={onRenamed}
								revealOn="row"
								taskId={item.id}
								title={item.title}
							/>
						</div>
						{item.isLegacy && (
							<span className="text-xs uppercase rounded px-1.5 py-0.5 bg-accent/20 text-description flex-shrink-0">
								Legacy
							</span>
						)}
					</div>
					<div className="flex items-center gap-2 text-xs text-description">
						<span className="uppercase">{formatDate(item.ts)}</span>
						<span>${item.totalCost?.toFixed(4) ?? 0}</span>
					</div>
				</div>

				{/* Hover icons, Claude-style: they stay out of the way until the row is hovered
				    (or focused from the keyboard), except the star, which stays lit when the chat
				    is favorited because that is state, not an action. */}
				<div className="flex items-center gap-1 flex-shrink-0 self-center">
					<Button
						aria-expanded={expanded}
						aria-label={expanded ? "Hide details" : "Show details"}
						className={cn(ICON_REVEAL, "transition-opacity", {
							"opacity-100 bg-accent/15": expanded,
						})}
						onClick={(e) => {
							e.stopPropagation()
							setExpanded(!expanded)
						}}
						size="icon"
						title={expanded ? "Hide details" : "Show details"}
						variant="ghost">
						<InfoIcon className="stroke-1 text-description" />
					</Button>
					<Button
						aria-label={isFavoritedItem ? "Remove from favorites" : "Add to favorites"}
						className={cn("transition-opacity", isFavoritedItem ? "opacity-100" : ICON_REVEAL)}
						disabled={pendingFavoriteToggles[item.id] !== undefined}
						onClick={(e) => {
							e.stopPropagation()
							toggleFavorite(item.id, isFavoritedItem)
						}}
						size="icon"
						title={isFavoritedItem ? "Remove from favorites" : "Add to favorites"}
						variant="ghost">
						<StarIcon
							className={cn("opacity-70", {
								"text-button-background fill-button-background opacity-100": isFavoritedItem,
							})}
						/>
					</Button>
					<Button
						aria-label="Delete"
						className={cn(ICON_REVEAL, "transition-opacity hover:text-error")}
						disabled={isFavoritedItem}
						onClick={(e) => {
							e.stopPropagation()
							handleDeleteHistoryItem(item.id)
						}}
						size="icon"
						title={isFavoritedItem ? "Unfavorite this chat before deleting it" : "Delete"}
						variant="ghost">
						<TrashIcon className="stroke-1" />
					</Button>
				</div>
			</div>

			{expanded && (
				<div className="mx-3 mb-2 p-2 bg-accent/10 rounded-xs">
					<div className="flex flex-col gap-1 w-full text-xs">
						<div className="flex justify-between items-center w-full gap-1 text-xs">
							<span className="font-medium text-description">Tokens:</span>
							<div className="flex items-center gap-1 text-description text-xs">
								<span className="flex items-center gap-1 text-description">
									<ArrowUpIcon className="text-description !size-1" />
									{formatLargeNumber(item.tokensIn || 0)}
								</span>
								<span className="flex items-center gap-1 text-description">
									<ArrowDownIcon className="text-description !size-1" />
									{formatLargeNumber(item.tokensOut || 0)}
								</span>
								{item.cacheWrites
									? item.cacheWrites > 0 && (
											<span className="flex items-center gap-1 text-description">
												<ArrowRightIcon className="text-description !size-1" />
												{formatLargeNumber(item.cacheWrites)}
											</span>
										)
									: null}
								{item.cacheReads
									? item.cacheReads > 0 && (
											<span className="flex items-center gap-1 text-description">
												<ArrowLeftIcon className="text-description !size-1" />
												{formatLargeNumber(item.cacheReads)}
											</span>
										)
									: null}
							</div>
						</div>

						{item.modelId && (
							<div className="flex justify-between items-center w-full gap-1 text-xs">
								<span className="font-medium text-description">Model:</span>
								<span className="text-description">{item.modelId}</span>
							</div>
						)}

						<div className="flex justify-between items-center w-full gap-1 text-xs">
							<span className="font-medium text-description">Size:</span>
							<span className="items-center gap-2 flex text-description">
								{formatSize(item.size)}
								<Button
									aria-label="Export"
									className="m-0 p-0"
									onClick={(e) => {
										e.stopPropagation()
										TaskServiceClient.exportTaskWithId(StringRequest.create({ value: item.id })).catch(
											(err) => console.error("Failed to export task:", err),
										)
									}}
									title="Export this chat"
									variant="ghost">
									<DownloadIcon />
								</Button>
							</span>
						</div>
					</div>
				</div>
			)}
		</div>
	)
}

export default memo(HistoryViewItem)
