import type { CCEncodingContext, CCParsingContext } from "@zwave-js/cc";
import {
	CommandClasses,
	type GetValueDB,
	type MaybeNotKnown,
	type MessageOrCCLogEntry,
	MessagePriority,
	type MessageRecord,
	type WithAddress,
	ZWaveError,
	ZWaveErrorCodes,
	validatePayload,
} from "@zwave-js/core";
import { Bytes, isPrintableASCII, num2hex } from "@zwave-js/shared";
import { validateArgs } from "@zwave-js/transformers";
import { CCAPI, PhysicalCCAPI } from "../lib/API.js";
import {
	type CCRaw,
	CommandClass,
	type InterviewContext,
	type RefreshValuesContext,
} from "../lib/CommandClass.js";
import {
	API,
	CCCommand,
	ccValueProperty,
	ccValues,
	commandClass,
	expectedCCResponse,
	implementedVersion,
} from "../lib/CommandClassDecorators.js";
import { V } from "../lib/Values.js";
import {
	DoorLockLoggingCommand,
	DoorLockLoggingEventType,
	type DoorLockLoggingRecord,
	DoorLockLoggingRecordStatus,
} from "../lib/_Types.js";
import { userCodeToLogString } from "./UserCodeCC.js";

interface DateSegments {
	year: number;
	month: number;
	day: number;
	hour: number;
	minute: number;
	second: number;
}

function segmentsToDate(segments: DateSegments): Date {
	return new Date(
		segments.year,
		segments.month - 1, // JS months are 0-based.
		segments.day,
		segments.hour,
		segments.minute,
		segments.second,
	);
}

const eventTypeLabel = {
	LockCode: "Locked via Access Code",
	UnlockCode: "Unlocked via Access Code",
	LockButton: "Locked via Lock Button",
	UnlockButton: "Unlocked via Unlock Button",
	LockCodeOutOfSchedule: "Out of Schedule Lock Attempt via Access Code",
	UnlockCodeOutOfSchedule: "Out of Schedule Unlock Attempt via Access Code",
	IllegalCode: "Illegal Access Code Entered",
	LockManual: "Manually Locked",
	UnlockManual: "Manually Unlocked",
	LockAuto: "Auto Locked",
	UnlockAuto: "Auto Unlocked",
	LockRemoteCode: "Locked via Remote Access Code",
	UnlockRemoteCode: "Unlocked via Remote Access Code",
	LockRemote: "Locked via Remote",
	UnlockRemote: "Unlocked via Remote",
	LockRemoteCodeOutOfSchedule:
		"Out of Schedule Lock Attempt via Remote Access Code",
	UnlockRemoteCodeOutOfSchedule:
		"Out of Schedule Unlock Attempt via Remote Access Code",
	RemoteIllegalCode: "Illegal Remote Access Code",
	LockManual2: "Manually Locked (2)",
	UnlockManual2: "Manually Unlocked (2)",
	LockSecured: "Lock Secured",
	LockUnsecured: "Lock Unsecured",
	UserCodeAdded: "User Code Added",
	UserCodeDeleted: "User Code Deleted",
	AllUserCodesDeleted: "All User Codes Deleted",
	AdminCodeChanged: "Admin Code Changed",
	UserCodeChanged: "User Code Changed",
	LockReset: "Lock Reset",
	ConfigurationChanged: "Configuration Changed",
	LowBattery: "Low Battery",
	NewBattery: "New Battery Installed",
	Unknown: "Unknown",
} as const;

const LATEST_RECORD_NUMBER_KEY = 0;

export const DoorLockLoggingCCValues = V.defineCCValues(
	CommandClasses["Door Lock Logging"],
	{
		...V.staticProperty("recordsCount", undefined, { internal: true }),
	},
);

@API(CommandClasses["Door Lock Logging"])
export class DoorLockLoggingCCAPI extends PhysicalCCAPI {
	public supportsCommand(
		cmd: DoorLockLoggingCommand,
	): MaybeNotKnown<boolean> {
		switch (cmd) {
			case DoorLockLoggingCommand.RecordsSupportedGet:
			case DoorLockLoggingCommand.RecordsSupportedReport:
			case DoorLockLoggingCommand.RecordGet:
			case DoorLockLoggingCommand.RecordReport:
				return true;
		}
		return super.supportsCommand(cmd);
	}

	public async getRecordsCount(): Promise<MaybeNotKnown<number>> {
		this.assertSupportsCommand(
			DoorLockLoggingCommand,
			DoorLockLoggingCommand.RecordsSupportedGet,
		);

		const cc = new DoorLockLoggingCCRecordsSupportedGet({
			nodeId: this.endpoint.nodeId,
			endpointIndex: this.endpoint.index,
		});
		const response = await this.host.sendCommand<
			DoorLockLoggingCCRecordsSupportedReport
		>(
			cc,
			this.commandOptions,
		);
		return response?.recordsCount;
	}

	/** Retrieves the specified audit record. Defaults to the latest one. */
	@validateArgs()
	public async getRecord(
		recordNumber: number = LATEST_RECORD_NUMBER_KEY,
	): Promise<MaybeNotKnown<DoorLockLoggingRecord>> {
		this.assertSupportsCommand(
			DoorLockLoggingCommand,
			DoorLockLoggingCommand.RecordGet,
		);

		const cc = new DoorLockLoggingCCRecordGet({
			nodeId: this.endpoint.nodeId,
			endpointIndex: this.endpoint.index,
			recordNumber,
		});
		const response = await this.host.sendCommand<
			DoorLockLoggingCCRecordReport
		>(
			cc,
			this.commandOptions,
		);
		return response?.record;
	}
}

@commandClass(CommandClasses["Door Lock Logging"])
@implementedVersion(1)
@ccValues(DoorLockLoggingCCValues)
export class DoorLockLoggingCC extends CommandClass {
	declare ccCommand: DoorLockLoggingCommand;

	public async interview(
		ctx: InterviewContext,
	): Promise<void> {
		const node = this.getNode(ctx)!;

		ctx.logNode(node.id, {
			endpoint: this.endpointIndex,
			message: `Interviewing ${this.ccName}...`,
			direction: "none",
		});

		await this.refreshValues(ctx);

		// Remember that the interview is complete
		this.setInterviewComplete(ctx, true);
	}

	public async refreshValues(
		ctx: RefreshValuesContext,
	): Promise<void> {
		const node = this.getNode(ctx)!;
		const endpoint = this.getEndpoint(ctx)!;
		const api = CCAPI.create(
			CommandClasses["Door Lock Logging"],
			ctx,
			endpoint,
		).withOptions({
			priority: MessagePriority.NodeQuery,
		});

		ctx.logNode(node.id, {
			endpoint: this.endpointIndex,
			message: "querying supported number of records...",
			direction: "outbound",
		});
		const recordsCount = await api.getRecordsCount();

		if (!recordsCount) {
			ctx.logNode(node.id, {
				endpoint: this.endpointIndex,
				message:
					"Door Lock Logging records count query timed out, skipping interview...",
				level: "warn",
			});
			return;
		}

		const recordsCountLogMessage = `supports ${recordsCount} record${
			recordsCount === 1 ? "" : "s"
		}`;
		ctx.logNode(node.id, {
			endpoint: this.endpointIndex,
			message: recordsCountLogMessage,
			direction: "inbound",
		});
	}
}

// @publicAPI
export interface DoorLockLoggingCCRecordsSupportedReportOptions {
	recordsCount: number;
}

@CCCommand(DoorLockLoggingCommand.RecordsSupportedReport)
@ccValueProperty("recordsCount", DoorLockLoggingCCValues.recordsCount)
export class DoorLockLoggingCCRecordsSupportedReport extends DoorLockLoggingCC {
	public constructor(
		options: WithAddress<DoorLockLoggingCCRecordsSupportedReportOptions>,
	) {
		super(options);

		// TODO: Check implementation:
		this.recordsCount = options.recordsCount;
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): DoorLockLoggingCCRecordsSupportedReport {
		validatePayload(raw.payload.length >= 1);
		const recordsCount = raw.payload[0];

		return new this({
			nodeId: ctx.sourceNodeId,
			recordsCount,
		});
	}

	public readonly recordsCount: number;

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(ctx),
			message: {
				"supported no. of records": this.recordsCount,
			},
		};
	}
}

function eventTypeToLabel(eventType: DoorLockLoggingEventType): string {
	return (
		(eventTypeLabel as any)[DoorLockLoggingEventType[eventType]]
			?? `Unknown ${num2hex(eventType)}`
	);
}

@CCCommand(DoorLockLoggingCommand.RecordsSupportedGet)
@expectedCCResponse(DoorLockLoggingCCRecordsSupportedReport)
export class DoorLockLoggingCCRecordsSupportedGet extends DoorLockLoggingCC {}

// @publicAPI
export interface DoorLockLoggingCCRecordReportOptions {
	recordNumber: number;
	record?: DoorLockLoggingRecord;
}

@CCCommand(DoorLockLoggingCommand.RecordReport)
export class DoorLockLoggingCCRecordReport extends DoorLockLoggingCC {
	public constructor(
		options: WithAddress<DoorLockLoggingCCRecordReportOptions>,
	) {
		super(options);

		// TODO: Check implementation:
		this.recordNumber = options.recordNumber;
		this.record = options.record;
	}

	public static from(
		raw: CCRaw,
		ctx: CCParsingContext,
	): DoorLockLoggingCCRecordReport {
		validatePayload(raw.payload.length >= 11);
		const recordNumber = raw.payload[0];
		const recordStatus = raw.payload[5] >>> 5;
		let record: DoorLockLoggingRecord | undefined;
		if (recordStatus !== DoorLockLoggingRecordStatus.Empty) {
			const dateSegments = {
				year: raw.payload.readUInt16BE(1),
				month: raw.payload[3],
				day: raw.payload[4],
				hour: raw.payload[5] & 0b11111,
				minute: raw.payload[6],
				second: raw.payload[7],
			};

			const eventType = raw.payload[8];
			const recordUserID = raw.payload[9];
			const userCodeLength = raw.payload[10];
			validatePayload(
				userCodeLength <= 10,
				raw.payload.length >= 11 + userCodeLength,
			);

			const userCodeBuffer = raw.payload.subarray(
				11,
				11 + userCodeLength,
			);
			// See User Code CC for a detailed description. We try to parse the code as ASCII if possible
			// and fall back to a buffer otherwise.
			const userCodeString = userCodeBuffer.toString("utf8");
			const userCode = isPrintableASCII(userCodeString)
				? userCodeString
				: userCodeBuffer;

			record = {
				eventType: eventType,
				label: eventTypeToLabel(eventType),
				timestamp: segmentsToDate(dateSegments).toISOString(),
				userId: recordUserID,
				userCode,
			};
		}

		return new this({
			nodeId: ctx.sourceNodeId,
			recordNumber,
			record,
		});
	}

	public readonly recordNumber: number;
	public readonly record?: DoorLockLoggingRecord;

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		let message: MessageRecord;

		if (!this.record) {
			message = {
				"record #": `${this.recordNumber} (empty)`,
			};
		} else {
			message = {
				"record #": `${this.recordNumber}`,
				"event type": this.record.label,
				timestamp: this.record.timestamp,
			};
			if (this.record.userId) {
				message["user ID"] = this.record.userId;
			}
			if (this.record.userCode) {
				message["user code"] = userCodeToLogString(
					this.record.userCode,
				);
			}
		}
		return {
			...super.toLogEntry(ctx),
			message,
		};
	}
}

// @publicAPI
export interface DoorLockLoggingCCRecordGetOptions {
	recordNumber: number;
}

function testResponseForDoorLockLoggingRecordGet(
	sent: DoorLockLoggingCCRecordGet,
	received: DoorLockLoggingCCRecordReport,
) {
	return (
		sent.recordNumber === LATEST_RECORD_NUMBER_KEY
		|| sent.recordNumber === received.recordNumber
	);
}

@CCCommand(DoorLockLoggingCommand.RecordGet)
@expectedCCResponse(
	DoorLockLoggingCCRecordReport,
	testResponseForDoorLockLoggingRecordGet,
)
export class DoorLockLoggingCCRecordGet extends DoorLockLoggingCC {
	public constructor(
		options: WithAddress<DoorLockLoggingCCRecordGetOptions>,
	) {
		super(options);
		this.recordNumber = options.recordNumber;
	}

	public static from(
		_raw: CCRaw,
		_ctx: CCParsingContext,
	): DoorLockLoggingCCRecordGet {
		throw new ZWaveError(
			`${this.name}: deserialization not implemented`,
			ZWaveErrorCodes.Deserialization_NotImplemented,
		);

		// return new DoorLockLoggingCCRecordGet({
		// 	nodeId: ctx.sourceNodeId,
		// });
	}

	public recordNumber: number;

	public serialize(ctx: CCEncodingContext): Promise<Bytes> {
		this.payload = Bytes.from([this.recordNumber]);
		return super.serialize(ctx);
	}

	public toLogEntry(ctx?: GetValueDB): MessageOrCCLogEntry {
		return {
			...super.toLogEntry(ctx),
			message: { "record number": this.recordNumber },
		};
	}
}
