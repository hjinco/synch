import type { SystemHealthDto } from "../../dto/system-health";

export interface GetSystemHealth {
	execute(): SystemHealthDto;
}
