import { IsString } from "class-validator";


export class MasterPasswordDTO {
    @IsString()
    masterPassword :string;

}