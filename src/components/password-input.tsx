"use client"

import * as React from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group'

type PasswordInputProps = Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type'
> & {
  ref?: React.Ref<HTMLInputElement>
}

export function PasswordInput({
  className,
  disabled,
  ref,
  ...props
}: PasswordInputProps) {
  const [showPassword, setShowPassword] = React.useState(false)

  return (
    <InputGroup className={cn(className)}>
      <InputGroupInput
        type={showPassword ? 'text' : 'password'}
        ref={ref}
        disabled={disabled}
        {...props}
      />
      <InputGroupAddon align="inline-end">
        <Button
          type='button'
          size='icon'
          variant='ghost'
          disabled={disabled}
          className='h-6 w-6 rounded-md text-muted-foreground'
          onClick={() => setShowPassword((prev) => !prev)}
        >
          {showPassword ? <Eye size={18} /> : <EyeOff size={18} />}
        </Button>
      </InputGroupAddon>
    </InputGroup>
  )
}
