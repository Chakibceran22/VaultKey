import { IsEmail, IsInt, IsOptional, IsString } from "class-validator";

export class CreateCredentialsDTO {
    @IsString()
    @IsOptional()
    username: string;

    @IsEmail()
    email: string;

    @IsString()
    password: string;

    @IsInt()
    domainId: number;

}