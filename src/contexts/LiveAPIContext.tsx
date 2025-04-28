/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { createContext, FC, ReactNode, useContext, useMemo } from "react";
import { useLiveAPI, UseLiveAPIResults } from "../hooks/use-live-api";

// Define the shape of the context, removing API key specifics
const LiveAPIContext = createContext<UseLiveAPIResults | undefined>(undefined);

export type LiveAPIProviderProps = {
  children: ReactNode;
  proxyUrl: string; // Expect the proxy URL prop
};

export const LiveAPIProvider: FC<LiveAPIProviderProps> = ({
  proxyUrl, // Use the proxyUrl prop
  children,
}) => {
  // Pass proxyUrl to the hook
  const liveAPI = useLiveAPI({ proxyUrl });

  // The context value now just contains the results from useLiveAPI
  const contextValue = useMemo(() => ({
    ...liveAPI,
  }), [liveAPI]); // Memoize based on liveAPI results

  return (
    <LiveAPIContext.Provider value={contextValue}>
      {children}
    </LiveAPIContext.Provider>
  );
};

export const useLiveAPIContext = () => {
  const context = useContext(LiveAPIContext);
  if (!context) {
    throw new Error("useLiveAPIContext must be used within a LiveAPIProvider");
  }
  return context;
};
