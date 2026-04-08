declare module '@holo-js/storage-s3' {
  export interface S3DriverOptions {
    accessKeyId?: string
    secretAccessKey?: string
    sessionToken?: string
    endpoint?: string
    region?: string
    bucket?: string
    forcePathStyleEndpoint?: boolean
  }

  const createS3Driver: (options: S3DriverOptions) => unknown
  export default createS3Driver
}
