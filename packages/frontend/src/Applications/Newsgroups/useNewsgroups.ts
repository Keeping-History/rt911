import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
	MediaStreamContext,
	type NewsgroupSource,
} from "../../Providers/MediaStream/MediaStreamContext";
import {
	allFolderPaths,
	buildGroupTree,
	filterGroups,
	flatGroupRows,
	flattenGroupTree,
	type GroupRow,
	type GroupSortField,
	sortGroupTree,
} from "./groupTree";
import {
	buildThreads,
	flattenThreads,
	type RenderRow,
	type SortField,
	type SortSpec,
	sortThreads,
} from "./newsgroupUtils";

/** Direction a freshly-clicked column adopts: dates open newest-first, text A→Z. */
const DEFAULT_DIR: Record<SortField, SortSpec["dir"]> = {
	date: "desc",
	subject: "asc",
	author: "asc",
};

export interface NewsgroupsState {
	/** Newsgroups available to browse (sources of type "usenet"), with counts. */
	groups: NewsgroupSource[];
	/** The newsgroup list as a flattened dot-notation tree honoring expand state. */
	groupRows: GroupRow[];
	/** Current newsgroup-name filter (substring match). */
	groupQuery: string;
	/** Update the newsgroup-name filter. */
	setGroupQuery: (query: string) => void;
	/** Expand or collapse one tree folder by its dotted path. */
	toggleGroupNode: (path: string) => void;
	/** Expand every folder in the newsgroup tree. */
	expandAllGroups: () => void;
	/** Collapse the newsgroup tree back to its top level. */
	collapseAllGroups: () => void;
	/** Whether the newsgroup list is shown as a tree (false = flat list). */
	treeView: boolean;
	/** Toggle between the dot-notation tree and a flat list of full names. */
	toggleTreeView: () => void;
	/** How the newsgroup list is ordered: by name (A→Z) or by message count. */
	groupSort: GroupSortField;
	/** Change the newsgroup-list ordering. */
	setGroupSort: (field: GroupSortField) => void;
	/** The currently-opened group, or null when browsing the group list. */
	selectedGroup: string | null;
	/** Open a group (server starts streaming it) or null to close. */
	selectGroup: (group: string | null) => void;
	/** The opened group's messages as sorted, collapsible render rows. */
	rows: RenderRow[];
	/** Active column sort (default: newest thread activity first). */
	sort: SortSpec;
	/** Click a column header: flip direction if active, else its sensible default. */
	setSort: (field: SortField) => void;
	/** Expand or collapse one thread by its stable key. */
	toggleThread: (key: string) => void;
	/** Fetch the page of messages older than the oldest currently shown. */
	loadOlder: () => void;
	connected: boolean;
}

/**
 * Drives the Newsgroups app: ref-counted usenet subscription, group selection
 * (which tells the server what to stream — a group can be huge, so nothing flows
 * until one is opened), and threading of the received messages.
 */
export function useNewsgroups(appId: string): NewsgroupsState {
	const {
		sources,
		usenetItems,
		subscribeUsenet,
		unsubscribeUsenet,
		setUsenetGroups,
		requestUsenetOlder,
		connected,
	} = useContext(MediaStreamContext);

	const [selectedGroup, setSelectedGroup] = useState<string | null>(null);
	const [sort, setSortSpec] = useState<SortSpec>({ field: "date", dir: "desc" });
	// Threads default to collapsed; this set holds the ones the user has expanded.
	const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
	// Newsgroup tree folders default collapsed; this set holds the expanded paths.
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
	const [groupQuery, setGroupQuery] = useState("");
	const [treeView, setTreeView] = useState(true);
	const [groupSort, setGroupSort] = useState<GroupSortField>("name");

	// Expand All / Collapse All act on the full (unfiltered) tree.
	const groupTree = useMemo(() => buildGroupTree(sources.usenet), [sources.usenet]);
	// Show a flat list when tree view is off or a filter is active; otherwise the
	// tree honoring the user's expand state. Either view is ordered by groupSort.
	const groupRows = useMemo(() => {
		if (!treeView || groupQuery.trim()) {
			return flatGroupRows(filterGroups(sources.usenet, groupQuery), groupSort);
		}
		return flattenGroupTree(sortGroupTree(groupTree, groupSort), expandedGroups);
	}, [sources.usenet, groupTree, expandedGroups, groupQuery, treeView, groupSort]);

	const toggleTreeView = useCallback(() => setTreeView((v) => !v), []);

	const toggleGroupNode = useCallback((path: string) => {
		setExpandedGroups((prev) => {
			const next = new Set(prev);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}, []);

	const expandAllGroups = useCallback(() => {
		setExpandedGroups(new Set(allFolderPaths(groupTree)));
	}, [groupTree]);

	const collapseAllGroups = useCallback(() => {
		setExpandedGroups(new Set());
	}, []);

	useEffect(() => {
		subscribeUsenet(appId);
		return () => unsubscribeUsenet(appId);
	}, [appId, subscribeUsenet, unsubscribeUsenet]);

	const selectGroup = useCallback(
		(group: string | null) => {
			setSelectedGroup(group);
			setUsenetGroups(group ? [group] : []);
			setExpanded(new Set()); // a fresh group starts fully collapsed
		},
		[setUsenetGroups],
	);

	const setSort = useCallback((field: SortField) => {
		setSortSpec((prev) =>
			prev.field === field
				? { field, dir: prev.dir === "asc" ? "desc" : "asc" }
				: { field, dir: DEFAULT_DIR[field] },
		);
	}, []);

	const toggleThread = useCallback((key: string) => {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);

	// usenetItems are already filtered server-side to the viewed group; the extra
	// guard keeps the view clean if a stale frame from a prior group slips in.
	const messages = useMemo(
		() => (selectedGroup ? usenetItems.filter((m) => m.newsgroup === selectedGroup) : []),
		[usenetItems, selectedGroup],
	);
	const rows = useMemo(
		() => flattenThreads(sortThreads(buildThreads(messages), sort), expanded),
		[messages, sort, expanded],
	);

	// Page back from the oldest message currently held for this group.
	const loadOlder = useCallback(() => {
		if (!selectedGroup || messages.length === 0) return;
		let oldest = messages[0].start_date;
		for (const m of messages) {
			if (new Date(m.start_date).getTime() < new Date(oldest).getTime()) oldest = m.start_date;
		}
		requestUsenetOlder(selectedGroup, oldest);
	}, [selectedGroup, messages, requestUsenetOlder]);

	return {
		groups: sources.usenet,
		groupRows,
		groupQuery,
		setGroupQuery,
		toggleGroupNode,
		expandAllGroups,
		collapseAllGroups,
		treeView,
		toggleTreeView,
		groupSort,
		setGroupSort,
		selectedGroup,
		selectGroup,
		rows,
		sort,
		setSort,
		toggleThread,
		loadOlder,
		connected,
	};
}
