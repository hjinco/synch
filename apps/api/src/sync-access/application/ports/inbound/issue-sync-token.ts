import type {
	SyncTokenIssueInput,
	SyncTokenIssueResponse,
} from "../../dto/token";

export interface IssueSyncToken {
	issueSyncToken(input: SyncTokenIssueInput): Promise<SyncTokenIssueResponse>;
}
