@description('Globally unique base name for the Azure resources.')
@minLength(3)
@maxLength(18)
param appName string

@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Home Connect application client ID.')
param homeConnectClientId string

@secure()
@description('Home Connect application client secret.')
param homeConnectClientSecret string

@description('Public callback URL registered in the Home Connect developer portal.')
param homeConnectRedirectUri string

@secure()
@minLength(32)
@description('Random secret used to sign the OAuth state cookie.')
param cookieSecret string

@description('Client ID of the Microsoft Entra app registration used by App Service Authentication.')
param microsoftAuthClientId string

@secure()
@description('Client secret value of the Microsoft Entra app registration.')
param microsoftAuthClientSecret string

@description('Microsoft Entra tenant containing the authorized user or guest account.')
param microsoftTenantId string = tenant().tenantId

@minLength(1)
@description('Microsoft Entra object IDs authorized to access the application.')
param allowedPrincipalIds array

@description('Only this Microsoft account email may access the application.')
param allowedEmail string = 'jparus@gmail.com'

var storageName = toLower(replace('${appName}store', '-', ''))

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}

resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: '${appName}-plan'
  location: location
  sku: {
    name: 'B1'
    tier: 'Basic'
  }
  properties: {
    reserved: true
  }
}

resource app 'Microsoft.Web/sites@2023-12-01' = {
  name: appName
  location: location
  properties: {
    httpsOnly: true
    serverFarmId: plan.id
    siteConfig: {
      alwaysOn: true
      ftpsState: 'Disabled'
      http20Enabled: true
      linuxFxVersion: 'NODE|22-lts'
      minTlsVersion: '1.2'
      numberOfWorkers: 1
      appSettings: [
        {
          name: 'HOME_CONNECT_CLIENT_ID'
          value: homeConnectClientId
        }
        {
          name: 'HOME_CONNECT_CLIENT_SECRET'
          value: homeConnectClientSecret
        }
        {
          name: 'HOME_CONNECT_REDIRECT_URI'
          value: homeConnectRedirectUri
        }
        {
          name: 'COOKIE_SECRET'
          value: cookieSecret
        }
        {
          name: 'AZURE_STORAGE_CONNECTION_STRING'
          value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};EndpointSuffix=${environment().suffixes.storage};AccountKey=${storage.listKeys().keys[0].value}'
        }
        {
          name: 'AZURE_TABLE_NAME'
          value: 'DishwasherLoop'
        }
        {
          name: 'CYCLE_TIMEZONE'
          value: 'Europe/Prague'
        }
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'true'
        }
        {
          name: 'WEBSITE_WARMUP_PATH'
          value: '/healthz'
        }
        {
          name: 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'
          value: microsoftAuthClientSecret
        }
        {
          name: 'REQUIRE_MICROSOFT_AUTH'
          value: 'true'
        }
        {
          name: 'APP_ALLOWED_EMAIL'
          value: allowedEmail
        }
        {
          name: 'APP_ALLOWED_PRINCIPAL_IDS'
          value: join(allowedPrincipalIds, ',')
        }
      ]
    }
  }
}

resource auth 'Microsoft.Web/sites/config@2023-12-01' = {
  parent: app
  name: 'authsettingsV2'
  properties: {
    platform: {
      enabled: true
      runtimeVersion: '~1'
    }
    globalValidation: {
      requireAuthentication: true
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
      excludedPaths: [
        '/healthz'
      ]
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: microsoftAuthClientId
          clientSecretSettingName: 'MICROSOFT_PROVIDER_AUTHENTICATION_SECRET'
          openIdIssuer: '${environment().authentication.loginEndpoint}${microsoftTenantId}/v2.0'
        }
        login: {
          loginParameters: [
            'scope=openid profile email'
          ]
        }
      }
    }
    login: {
      tokenStore: {
        enabled: true
      }
    }
    httpSettings: {
      requireHttps: true
      routes: {
        apiPrefix: '/.auth'
      }
      forwardProxy: {
        convention: 'Standard'
      }
    }
  }
}

output appUrl string = 'https://${app.properties.defaultHostName}'
output homeConnectCallbackUrl string = 'https://${app.properties.defaultHostName}/auth/callback'
output microsoftAuthCallbackUrl string = 'https://${app.properties.defaultHostName}/.auth/login/aad/callback'
