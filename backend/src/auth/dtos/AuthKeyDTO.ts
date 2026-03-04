import { IsString } from "class-validator";

export class AuthKeyDTO {
    @IsString()
    authKey: string;

}