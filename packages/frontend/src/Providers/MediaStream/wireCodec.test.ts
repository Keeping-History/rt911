import { encode } from "@msgpack/msgpack";
import { describe, expect, it } from "vitest";
import { decodeWireMessage } from "./wireCodec";

// Mirror the server path: Go encodes time.Time as the msgpack timestamp
// extension. msgpack's default encoder does the same for a JS Date, so encoding
// a Date here produces the exact ext bytes the backend emits.
function frame(obj: unknown): ArrayBuffer {
	const bytes = encode(obj);
	return bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
}

describe("decodeWireMessage", () => {
	it("decodes a timestamp extension to an ISO string", () => {
		const at = new Date("2001-09-11T15:26:00Z");
		const decoded = decodeWireMessage<{ time: string }>(frame({ time: at }));
		expect(decoded.time).toBe("2001-09-11T15:26:00.000Z");
		// Same instant must compare equal — instant-item detection relies on this.
		expect(new Date(decoded.time).getTime()).toBe(at.getTime());
	});

	it("decodes a full items frame to the expected object", () => {
		const start = new Date("2001-09-11T15:26:00Z");
		const decoded = decodeWireMessage<{
			type: string;
			time: string;
			items: Array<{
				id: number;
				title: string;
				start_date: string;
				end_date: string;
				format: string;
			}>;
		}>(
			frame({
				type: "items",
				time: start,
				items: [
					{
						id: 5821,
						title: "ID Rountree",
						start_date: start,
						end_date: start,
						format: "mp3",
					},
				],
			}),
		);

		expect(decoded.type).toBe("items");
		expect(decoded.items).toHaveLength(1);
		const item = decoded.items[0];
		expect(item.id).toBe(5821);
		expect(item.title).toBe("ID Rountree");
		expect(typeof item.start_date).toBe("string");
		// start_date === end_date is the instant-item signal the provider checks.
		expect(item.start_date).toBe(item.end_date);
	});

	it("preserves numeric and string field types across the wire", () => {
		const decoded = decodeWireMessage<{
			id: number;
			volume: number;
			url: string;
			approved: number;
		}>(frame({ id: 42, volume: 0.5, url: "x.mp3", approved: 1 }));
		expect(decoded.id).toBe(42);
		expect(decoded.volume).toBeCloseTo(0.5);
		expect(decoded.url).toBe("x.mp3");
		expect(decoded.approved).toBe(1);
	});
});
