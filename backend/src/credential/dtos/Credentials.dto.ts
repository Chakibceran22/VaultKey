import { IsInt, IsOptional, IsString } from "class-validator";

export class CreateCredentialsDTO {
    @IsString()
    @IsOptional()
    username: string;

    @IsString()
    email: string;

    @IsString()
    password: string;

    @IsInt()
    domainId: number;

}