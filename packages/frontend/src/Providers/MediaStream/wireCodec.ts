import {
	decode,
	decodeTimestampToTimeSpec,
	EXT_TIMESTAMP,
	ExtensionCodec,
} from "@msgpack/msgpack";

// Server→client frames are MessagePack binary (client→server stays JSON text).
// Go encodes time.Time as the msgpack timestamp extension; we override that ext
// to return an ISO string so the decoded shape matches the TS interfaces exactly
// (MediaItem.start_date/end_date stay string-typed, and the provider's
// `start_date === end_date` instant check + `new Date(...)` calls keep working).
// A fresh ExtensionCodec carries no built-in registrations, so registering
// EXT_TIMESTAMP here is what gives us timestamp decoding at all.
export const extensionCodec = new ExtensionCodec();
extensionCodec.register({
	type: EXT_TIMESTAMP,
	encode: () => null, // client never encodes binary
	decode: (data: Uint8Array): string => {
		const { sec, nsec } = decodeTimestampToTimeSpec(data);
		return new Date(sec * 1000 + Math.floor(nsec / 1e6)).toISOString();
	},
});

// decodeWireMessage turns a raw binary frame into its decoded object. Timestamps
// arrive as ISO strings (see the extension codec above).
export function decodeWireMessage<T = unknown>(data: ArrayBuffer): T {
	return decode(new Uint8Array(data), { extensionCodec }) as T;
}
