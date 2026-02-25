
import { EMAIL_SELECTORS, PASSWORD_SELECTORS } from "./selectorConfig";
export const shouldActivate = ():boolean => {
    const url = window.location.pathname.toLowerCase();
    console.log(`The URL from the Content file, ${url} `)
    const hostname = window.location.hostname;
    const blcokedHostNames = [
        "chrome://",
        "brave://"
    ]

    if(blcokedHostNames.some(b => hostname.includes(b))) return false

    const hasEmailInput = !!document.querySelector(
        EMAIL_SELECTORS
    )

    const hasPasswordInput = !!document.querySelector(
        PASSWORD_SELECTORS
    )

    return hasEmailInput && hasPasswordInput
}