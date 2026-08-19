import type { SystemHealthDto } from "../dto/system-health";
import type { GetSystemHealth } from "../ports/inbound/get-system-health";

export class GetSystemHealthUseCase implements GetSystemHealth {
	execute(): SystemHealthDto {
		return {
			ok: true,
			service: "synch-api",
		};
	}
}
