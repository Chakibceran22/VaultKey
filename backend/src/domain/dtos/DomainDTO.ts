import { IsString } from "class-validator";

export class DomainDTO {
    @IsString()
    name: string;
}