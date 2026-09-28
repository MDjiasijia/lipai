/**
 * 布尔开关三件套：
 * `const [flag, setFlagOn, setFlagOff, toggleFlag] = useFlag()`。
 * 比 useState(false) + 四处 setFlag(v => …) 少一半样板。
 */
import { useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'

type Handler = Dispatch<SetStateAction<boolean>>

export default function useFlag(initial = false): [boolean, Handler, Handler, Handler] {
  const [value, setValue] = useState(initial)
  return [value, setValue, setValue, setValue]
}
