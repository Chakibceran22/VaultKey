class DomainService {
    async getDomains(token: string) {
        let response;
        try {
            response = await window.api.fetchDomains(token)
        } catch (error: any) {
            throw new Error(`API call failed: ${error.message}`)
        }

        if (response.error) {
            throw new Error('Failed to fetch domains')
        }

        return response.domains
    }


    async registerDomain(token: string, domainName: string){
        let response;
        try {
            response = await window.api.registerDomain(token, domainName)
            return response.success

        } catch (error: any) {
            console.log("Error registering domain:", error)
            throw new Error(error.message || 'Failed to register domain')
        }
    }
}


export const domainService = new DomainService()