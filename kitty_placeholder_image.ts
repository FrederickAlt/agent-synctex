export interface ImageDimensions {
	widthPx: number;
	heightPx: number;
}

export interface CellDimensions {
	widthPx: number;
	heightPx: number;
}

export interface KittyPlaceholderRenderOptions {
	title: string;
	base64Data: string;
	imageId: number;
	width: number;
	maxWidthCells: number;
	imageDimensions: ImageDimensions;
	cellDimensions: CellDimensions;
}

export interface KittyPlaceholderImageRender {
	lines: string[];
	refreshSequence: string;
	columns: number;
	rows: number;
}

export class KittyImageRefreshRegistry {
	private readonly sequences = new Map<number, string>();
	private readonly maxEntries: number;

	constructor(maxEntries = 8) {
		this.maxEntries = maxEntries;
	}

	remember(imageId: number, sequence: string): void {
		this.sequences.delete(imageId);
		this.sequences.set(imageId, sequence);
		while (this.sequences.size > this.maxEntries) {
			const oldest = this.sequences.keys().next().value;
			if (oldest === undefined) break;
			this.sequences.delete(oldest);
		}
	}

	refresh(write: (sequence: string) => void = (sequence) => process.stdout.write(sequence)): void {
		if (this.sequences.size === 0) return;
		write([...this.sequences.values()].join(""));
	}

	clear(): void {
		this.sequences.clear();
	}

	get size(): number {
		return this.sequences.size;
	}
}

const KITTY_PLACEHOLDER = "\u{10EEEE}";
const KITTY_CHUNK_SIZE = 4096;
const ROW_COLUMN_DIACRITICS = [
	0x0305, 0x030d, 0x030e, 0x0310, 0x0312, 0x033d, 0x033e, 0x033f,
	0x0346, 0x034a, 0x034b, 0x034c, 0x0350, 0x0351, 0x0352, 0x0357,
	0x035b, 0x0363, 0x0364, 0x0365, 0x0366, 0x0367, 0x0368, 0x0369,
	0x036a, 0x036b, 0x036c, 0x036d, 0x036e, 0x036f, 0x0483, 0x0484,
	0x0485, 0x0486, 0x0487, 0x0592, 0x0593, 0x0594, 0x0595, 0x0597,
	0x0598, 0x0599, 0x059c, 0x059d, 0x059e, 0x059f, 0x05a0, 0x05a1,
	0x05a8, 0x05a9, 0x05ab, 0x05ac, 0x05af, 0x05c4, 0x0610, 0x0611,
	0x0612, 0x0613, 0x0614, 0x0615, 0x0616, 0x0617, 0x0657, 0x0658,
	0x0659, 0x065a, 0x065b, 0x065d, 0x065e, 0x06d6, 0x06d7, 0x06d8,
	0x06d9, 0x06da, 0x06db, 0x06dc, 0x06df, 0x06e0, 0x06e1, 0x06e2,
	0x06e4, 0x06e7, 0x06e8, 0x06eb, 0x06ec, 0x0730, 0x0732, 0x0733,
	0x0735, 0x0736, 0x073a, 0x073d, 0x073f, 0x0740, 0x0741, 0x0743,
	0x0745, 0x0747, 0x0749, 0x074a, 0x07eb, 0x07ec, 0x07ed, 0x07ee,
	0x07ef, 0x07f0, 0x07f1, 0x07f3, 0x0816, 0x0817, 0x0818, 0x0819,
	0x081b, 0x081c, 0x081d, 0x081e, 0x081f, 0x0820, 0x0821, 0x0822,
	0x0823, 0x0825, 0x0826, 0x0827, 0x0829, 0x082a, 0x082b, 0x082c,
].map((codePoint) => String.fromCodePoint(codePoint));

function calculateImageRows(imageDimensions: ImageDimensions, targetWidthCells: number, cellDimensions: CellDimensions): number {
	const targetWidthPx = targetWidthCells * cellDimensions.widthPx;
	const scale = targetWidthPx / imageDimensions.widthPx;
	const scaledHeightPx = imageDimensions.heightPx * scale;
	return Math.max(1, Math.ceil(scaledHeightPx / cellDimensions.heightPx));
}

function kittyGraphicsCommand(params: string[], payload = ""): string {
	return `\x1b_G${params.join(",")};${payload}\x1b\\`;
}

export function wrapKittySequenceForTmux(sequence: string): string {
	return `\x1bPtmux;${sequence.replace(/\x1b/g, "\x1b\x1b")}\x1b\\`;
}

export function kittyTransmitVirtualPlacementCommand(base64Data: string, imageId: number, columns: number, rows: number): string {
	const params = ["a=T", "U=1", "f=100", "q=2", `i=${imageId}`, `c=${columns}`, `r=${rows}`];
	if (base64Data.length <= KITTY_CHUNK_SIZE) return kittyGraphicsCommand(params, base64Data);

	const chunks: string[] = [];
	for (let offset = 0; offset < base64Data.length; offset += KITTY_CHUNK_SIZE) {
		const chunk = base64Data.slice(offset, offset + KITTY_CHUNK_SIZE);
		const isFirst = offset === 0;
		const isLast = offset + KITTY_CHUNK_SIZE >= base64Data.length;
		if (isFirst) {
			chunks.push(kittyGraphicsCommand([...params, "m=1"], chunk));
		} else {
			chunks.push(kittyGraphicsCommand([`m=${isLast ? 0 : 1}`], chunk));
		}
	}
	return chunks.join("");
}

export function kittyPlaceholderCell(imageId: number, row: number, column: number): string {
	const red = (imageId >> 16) & 0xff;
	const green = (imageId >> 8) & 0xff;
	const blue = imageId & 0xff;
	return `\x1b[38;2;${red};${green};${blue}m${KITTY_PLACEHOLDER}${ROW_COLUMN_DIACRITICS[row]}${ROW_COLUMN_DIACRITICS[column]}\x1b[39m`;
}

export function kittyPlaceholderLine(imageId: number, row: number, columns: number): string {
	return Array.from({ length: columns }, (_value, column) => kittyPlaceholderCell(imageId, row, column)).join("");
}

export function buildKittyPlaceholderImageRender(options: KittyPlaceholderRenderOptions): KittyPlaceholderImageRender {
	const maxCoordinate = ROW_COLUMN_DIACRITICS.length;
	const columns = Math.max(1, Math.min(options.width - 2, options.maxWidthCells, maxCoordinate));
	const rows = Math.min(calculateImageRows(options.imageDimensions, columns, options.cellDimensions), maxCoordinate);
	const refreshSequence = wrapKittySequenceForTmux(
		kittyTransmitVirtualPlacementCommand(options.base64Data, options.imageId, columns, rows),
	);
	const imageLines = Array.from({ length: rows }, (_value, row) => `${row === 0 ? refreshSequence : ""}${kittyPlaceholderLine(options.imageId, row, columns)}`);
	return { lines: [options.title, ...imageLines], refreshSequence, columns, rows };
}

export function renderKittyPlaceholderImageLines(options: KittyPlaceholderRenderOptions): string[] {
	return buildKittyPlaceholderImageRender(options).lines;
}

