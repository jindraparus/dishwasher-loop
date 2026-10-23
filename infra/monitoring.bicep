@description('Name of the existing Dishwasher Loop Web App in this resource group.')
param appName string

@description('Azure region for the Log Analytics workspace and alert.')
param location string = resourceGroup().location

@minLength(3)
@description('Email address to receive Azure Monitor fired and resolved notifications.')
param alertEmail string

@description('Enable only after console-log ingestion has been verified.')
param alertEnabled bool = false

resource app 'Microsoft.Web/sites@2023-12-01' existing = {
  name: appName
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${appName}-logs'
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource consoleLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'dishwasher-connectivity'
  scope: app
  properties: {
    workspaceId: workspace.id
    logAnalyticsDestinationType: 'Dedicated'
    logs: [
      {
        category: 'AppServiceConsoleLogs'
        enabled: true
      }
    ]
  }
}

resource email 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${appName}-offline-email'
  location: 'global'
  properties: {
    groupShortName: 'Dishwasher'
    enabled: true
    emailReceivers: [
      {
        name: 'Dishwasher owner'
        emailAddress: alertEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

var alertQuery = replace(loadTextContent('offline-alert.kql'), '__APP_RESOURCE_ID__', app.id)

resource offlineAlert 'Microsoft.Insights/scheduledQueryRules@2023-12-01' = {
  name: '${appName}-dishwasher-offline'
  location: location
  kind: 'LogAlert'
  properties: {
    displayName: 'Dishwasher offline for at least 5 minutes'
    description: 'Home Connect confirmed the appliance offline for at least five minutes. Dimensions identify the appliance and UTC detection time. Check Home Connect and the dashboard. Do not interrupt an active software update.'
    severity: 2
    enabled: alertEnabled
    evaluationFrequency: 'PT5M'
    windowSize: 'P2D'
    scopes: [
      workspace.id
    ]
    autoMitigate: true
    skipQueryValidation: true
    criteria: {
      allOf: [
        {
          query: alertQuery
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
          dimensions: [
            {
              name: 'applianceId'
              operator: 'Include'
              values: [
                '*'
              ]
            }
            {
              name: 'applianceName'
              operator: 'Include'
              values: [
                '*'
              ]
            }
            {
              name: 'offlineSince'
              operator: 'Include'
              values: [
                '*'
              ]
            }
          ]
        }
      ]
    }
    actions: {
      actionGroups: [
        email.id
      ]
      customProperties: {
        dashboardUrl: 'https://${app.properties.defaultHostName}'
      }
    }
  }
}

output workspaceName string = workspace.name
output alertRuleName string = offlineAlert.name
output actionGroupName string = email.name
output query string = alertQuery
