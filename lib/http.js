/* lib/http.js
 *
 * Shared HTTP helper used by extension.js and prefs.js.
 *
 * Copyright (C) 2026 Benjamin Oswald <info@oswald.dev>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import Soup from 'gi://Soup';

/**
 * Issue a GET request via the provided Soup.Session and parse the response as JSON.
 *
 * The session is borrowed — callers remain responsible for its lifecycle
 * (e.g. abort() on destroy). Rejects on transport or JSON-parse errors.
 *
 * @param {Soup.Session} session - Long-lived Soup session to reuse.
 * @param {string} url - Request URL.
 * @param {Object<string,string>} [headers] - Extra request headers.
 * @returns {Promise<any>} - Parsed JSON response.
 */
export function soupGetJson(session, url, headers = {}) {
    const message = Soup.Message.new('GET', url);
    for (const [k, v] of Object.entries(headers))
        message.request_headers.append(k, v);

    return new Promise((resolve, reject) => {
        session.send_and_read_async(message, 0, null, (_s, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                const text = new TextDecoder().decode(bytes.get_data());
                resolve(JSON.parse(text));
            } catch (e) {
                reject(e);
            }
        });
    });
}
