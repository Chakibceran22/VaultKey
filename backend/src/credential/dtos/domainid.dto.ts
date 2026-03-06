import { IsInt } from "class-validator";

export class DomainIDDTO {
    @IsInt()
    domainID: number;
}