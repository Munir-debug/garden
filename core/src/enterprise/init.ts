/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"
import dedent from "dedent"
import { LogEntry } from "../logger/log-entry"
import { deline } from "../util/string"
import { getSecrets } from "./secrets"
import { StringMap } from "../config/common"
import { EnterpriseApi } from "./api"

export interface EnterpriseInitParams {
  log: LogEntry
  projectId: string | null
  enterpriseApi: EnterpriseApi
  environmentName: string
}

export interface GardenEnterpriseContext {
  clientAuthToken: string
  projectId: string
  enterpriseDomain: string
}

export async function enterpriseInit({ log, projectId, enterpriseApi, environmentName }: EnterpriseInitParams) {
  const clientAuthToken = await enterpriseApi.readAuthToken()
  let secrets: StringMap = {}
  // If a client auth token exists in local storage, we assume that the user wants to be logged in.
  if (clientAuthToken) {
    if (!enterpriseApi.getDomain() || !projectId) {
      const errorMessages: string[] = []
      if (!enterpriseApi.getDomain()) {
        errorMessages.push(deline`
          ${chalk.bold("project.domain")} is not set in your project-level ${chalk.bold("garden.yml")}. Make sure it
          is set to the appropriate API backend endpoint (e.g. http://myusername-cloud-api.cloud.dev.garden.io,
          with an http/https prefix).
        `)
      }
      if (!projectId) {
        errorMessages.push(deline`
          ${chalk.bold("project.id")} is not set in your project-level ${chalk.bold("garden.yml")}. Please visit
          Garden Enterprise's web UI for your project and copy your project's ID from there.
        `)
      }
      if (errorMessages.length > 0) {
        log.verbose(
          chalk.gray(dedent`
            ${errorMessages.join("\n\n")}

            Logging out via the ${chalk.bold("garden logout")} command will suppress this message.`)
        )
      }
    } else {
      const tokenIsValid = await enterpriseApi.checkClientAuthToken(log)
      if (tokenIsValid) {
        secrets = await getSecrets({
          projectId,
          enterpriseApi,
          clientAuthToken,
          log,
          environmentName,
        })
        log.silly(`Fetched ${Object.keys(secrets).length} secrets from ${enterpriseApi.getDomain()}`)
      } else {
        log.warn(deline`
          You were previously logged in to Garden Enterprise, but your session has expired or is invalid. Please run
          ${chalk.bold("garden login")} to continue using enterprise features, or run ${chalk.bold("garden logout")}
          to suppress this message.
        `)
      }
    }
  }

  return { clientAuthToken, secrets }
}
