import { Optional } from "@nestjs/common";
import { IsEmail, IsString } from "class-validator";

export class UpdateCredentialDTO {
    @Optional()
    @IsString()
    username?: string;

    @Optional()
    @IsString()
    password?: string;

    @Optional()
    @IsEmail()
    email?: string;


}