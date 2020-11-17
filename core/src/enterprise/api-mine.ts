/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { got, GotResponse, GotHeaders } from "../util/http"
import { gardenEnv } from "../constants"

const apiPrefix = "api"

// If a GARDEN_AUTH_TOKEN is present and Garden is NOT running from a workflow runner pod,
// switch to ci-token authentication method.
export const authTokenHeader =
  gardenEnv.GARDEN_AUTH_TOKEN && !gardenEnv.GARDEN_GE_SCHEDULED ? "x-ci-token" : "x-access-auth-token"
export const makeAuthHeader = (clientAuthToken: string) => ({ [authTokenHeader]: clientAuthToken })

export interface ApiFetchParams {
  hostname: string
  path: string
  headers: GotHeaders
  method: "GET" | "POST" | "PUT" | "PATCH" | "HEAD" | "DELETE"
}

export async function apiFetch(params: ApiFetchParams): Promise<GotResponse> {
  const { hostname, path, method, headers } = params
  return got(`${hostname}/${apiPrefix}/${path}`, {
    method,
    headers: {
      ...headers,
      ...makeAuthHeader("clientAuthToken"),
    },
  })
}
