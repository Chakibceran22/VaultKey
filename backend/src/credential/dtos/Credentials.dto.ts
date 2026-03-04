import { IsInt, IsOptional, IsString } from "class-validator";

export class CredentialsDTO {
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