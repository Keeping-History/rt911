import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { MediaStreamContext } from "../../Providers/MediaStream/MediaStreamContext";
import { buildThreadTree, type ThreadNode } from "./newsgroupUtils";

export interface NewsgroupsState {
	/** Newsgroup names available to browse (sources of type "usenet"). */
	groups: string[];
	/** The currently-opened group, or null when browsing the group list. */
	selectedGroup: string | null;
	/** Open a group (server starts streaming it) or null to close. */
	selectGroup: (group: string | null) => void;
	/** The opened group's messages as a threaded, depth-annotated list. */
	thread: ThreadNode[];
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
		connected,
	} = useContext(MediaStreamContext);

	const [selectedGroup, setSelectedGroup] = useState<string | null>(null);

	useEffect(() => {
		subscribeUsenet(appId);
		return () => unsubscribeUsenet(appId);
	}, [appId, subscribeUsenet, unsubscribeUsenet]);

	const selectGroup = useCallback(
		(group: string | null) => {
			setSelectedGroup(group);
			setUsenetGroups(group ? [group] : []);
		},
		[setUsenetGroups],
	);

	// usenetItems are already filtered server-side to the viewed group; the extra
	// guard keeps the view clean if a stale frame from a prior group slips in.
	const messages = useMemo(
		() => (selectedGroup ? usenetItems.filter((m) => m.newsgroup === selectedGroup) : []),
		[usenetItems, selectedGroup],
	);
	const thread = useMemo(() => buildThreadTree(messages), [messages]);

	return { groups: sources.usenet, selectedGroup, selectGroup, thread, connected };
}
